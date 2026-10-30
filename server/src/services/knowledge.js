// Company policy knowledge base: text extraction, chunking and search.
// Search = keyword ranking (BM25) + optional meaning-based search with a tiny
// Ollama embedding model. Everything stays on your server.
import mongoose from 'mongoose';
import mammoth from 'mammoth';
import PolicyChunk from '../models/PolicyChunk.js';
import PolicyDoc from '../models/PolicyDoc.js';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// 1. Text extraction
// ---------------------------------------------------------------------------
export function fileType(filename = '', mimetype = '') {
  const f = filename.toLowerCase();
  if (f.endsWith('.pdf') || mimetype === 'application/pdf') return 'pdf';
  if (f.endsWith('.docx') || mimetype.includes('wordprocessingml')) return 'docx';
  if (f.endsWith('.txt') || f.endsWith('.md') || mimetype.startsWith('text/')) return 'txt';
  return null;
}

export async function extractText(buffer, type) {
  let text = '';
  if (type === 'pdf') {
    text = await pdfToText(buffer);
  } else if (type === 'docx') {
    const { value } = await mammoth.extractRawText({ buffer });
    text = value || '';
  } else {
    text = buffer.toString('utf8');
  }
  return cleanText(text);
}

// PDF text extraction with Mozilla PDF.js (runs fully offline)
async function pdfToText(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    useSystemFonts: true,
    verbosity: 0,
  }).promise;
  const pages = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      let out = '';
      let lastY = null;
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const y = item.transform?.[5];
        // New line when the vertical position changes a lot (keeps paragraphs/headings apart)
        if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 2) {
          out += Math.abs(y - lastY) > (item.height || 10) * 1.6 ? '\n\n' : '\n';
        }
        out += item.str;
        if (item.hasEOL) out += '\n';
        if (y !== undefined) lastY = y;
      }
      pages.push(out);
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return pages.join('\n\n');
}

export function cleanText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .replace(/(\w)-\n(\w)/g, '$1$2') // words hyphenated across lines in PDFs
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// 2. Chunking: split a document into passages of ~CHUNK_SIZE characters,
//    keeping the nearest section heading with each passage.
// ---------------------------------------------------------------------------
const CHUNK_SIZE = 700;
const MAX_PARA = 1000;

function looksLikeHeading(line, isFirstOfBlock = false, blockHasMore = false) {
  const l = line.trim();
  if (!l || l.length > 90) return false;
  // A short line on its own at the top of a paragraph, like "Passwords" or "Hotel limits"
  if (isFirstOfBlock && blockHasMore && l.length <= 60 && l.split(' ').length <= 7 && !/[.,;!?।]$/.test(l) && /^[\p{Lu}\d]/u.test(l))
    return true;
  if (/^(\d+(\.\d+)*[.)]?|[IVX]+\.|[A-Z]\.)\s+\S/.test(l) && !/[.:;]$/.test(l) && l.split(' ').length <= 12) return true;
  if (l === l.toUpperCase() && /[A-Z]/.test(l) && l.split(' ').length <= 10) return true;
  if (/:$/.test(l) && l.split(' ').length <= 8) return true;
  return false;
}

function splitSentences(p) {
  return p.match(/[^.!?।]+[.!?।]+["')\]]*\s*|[^.!?।]+$/g) || [p];
}

export function chunkText(text) {
  // Paragraphs: blank-line separated; PDFs often have single newlines inside paragraphs
  const blocks = text.split(/\n\s*\n/).flatMap((b) => {
    const lines = b.split('\n');
    // Pull a heading line off the top of a block
    const out = [];
    let buf = [];
    for (const [li, line] of lines.entries()) {
      if (looksLikeHeading(line, li === 0 || buf.length === 0, li < lines.length - 1)) {
        if (buf.length) out.push({ text: buf.join(' ') });
        buf = [];
        out.push({ heading: line.trim().replace(/:$/, '') });
      } else buf.push(line.trim());
    }
    if (buf.length) out.push({ text: buf.join(' ') });
    return out;
  });

  // Word files put each heading in its own paragraph: a short stand-alone line
  // followed by a normal paragraph is treated as a heading too.
  for (let i = 0; i < blocks.length - 1; i++) {
    const b = blocks[i];
    if (b.text && blocks[i + 1].text && looksLikeHeading(b.text, true, true)) blocks[i] = { heading: b.text.trim() };
  }

  const chunks = [];
  let heading = '';
  let current = '';
  let currentHeading = '';
  const flush = () => {
    const t = current.trim();
    if (t.length > 20) chunks.push({ heading: currentHeading, text: t });
    current = '';
  };

  for (const b of blocks) {
    if (b.heading) {
      flush();
      heading = b.heading;
      currentHeading = heading;
      continue;
    }
    const pieces = b.text.length > MAX_PARA ? splitSentences(b.text) : [b.text];
    for (const piece of pieces) {
      if (current && (current + ' ' + piece).length > CHUNK_SIZE) {
        const prevLast = splitSentences(current).slice(-1)[0] || '';
        flush();
        currentHeading = heading;
        // small overlap so an answer split across two passages isn't lost
        if (prevLast.length < 250) current = prevLast.trim();
      }
      if (!current) currentHeading = heading;
      current = current ? current + ' ' + piece.trim() : piece.trim();
    }
  }
  flush();
  return chunks.map((c, i) => ({ ...c, index: i }));
}

// ---------------------------------------------------------------------------
// 3. Keyword search (BM25)
// ---------------------------------------------------------------------------
const STOP = new Set(
  'a an and are as at be by can do does for from has have how i if in is it its me my of on or our so that the their them then there these they this to was we what when where which who why will with you your am been being did get got just more most no not only other same should than too very would could about into over under also any each few how much many'.split(
    ' '
  )
);

function stem(w) {
  if (w.length <= 4 || !/^[a-z]+$/.test(w)) return w;
  if (w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.endsWith('ing') && w.length > 6) return w.slice(0, -3);
  if (w.endsWith('ed') && w.length > 5) return w.slice(0, -2);
  if (w.endsWith('es') && /(ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

export function tokenize(text) {
  return (
    String(text || '')
      .normalize('NFKC')
      .toLowerCase()
      .match(/[\p{L}\p{N}\p{M}]+/gu) || []
  )
    .filter((t) => !STOP.has(t) && (t.length > 1 || /\d/.test(t)))
    .map(stem);
}

// In-memory index of all enabled passages. Rebuilt whenever documents change.
let index = null;
let indexVersion = 0;
let builtVersion = -1;

export function invalidateIndex() {
  indexVersion++;
}

async function getIndex() {
  if (index && builtVersion === indexVersion) return index;
  if (mongoose.connection.readyState !== 1) return index || { chunks: [], df: new Map(), avgLen: 1 };
  const enabledDocs = await PolicyDoc.find({ enabled: true }).select('_id').lean();
  const ids = enabledDocs.map((d) => d._id);
  const raw = await PolicyChunk.find({ docId: { $in: ids } }).lean();
  const chunks = raw.map((c) => {
    const tokens = tokenize(`${c.docTitle} ${c.heading} ${c.heading} ${c.text}`);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    return { ...c, tf, len: tokens.length };
  });
  const df = new Map();
  for (const c of chunks) for (const t of c.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const avgLen = chunks.reduce((s, c) => s + c.len, 0) / (chunks.length || 1);
  index = { chunks, df, avgLen };
  builtVersion = indexVersion;
  return index;
}

function bm25(queryTokens, idx) {
  const N = idx.chunks.length;
  const k1 = 1.4;
  const b = 0.75;
  const uniq = [...new Set(queryTokens)];
  return idx.chunks.map((c) => {
    let s = 0;
    for (const t of uniq) {
      const f = c.tf.get(t);
      if (!f) continue;
      const n = idx.df.get(t) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * c.len) / idx.avgLen)));
    }
    return s;
  });
}

// ---------------------------------------------------------------------------
// 4. Meaning-based search with a small embedding model (optional)
// ---------------------------------------------------------------------------
export async function embed(texts) {
  if (!config.embedModel || !texts.length) return null;
  try {
    const r = await fetch(`${config.ollamaUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.embedModel, input: texts, keep_alive: config.keepAlive }),
    });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 150)}`);
    const data = await r.json();
    return data.embeddings || null;
  } catch (err) {
    console.warn(`Embedding with ${config.embedModel} failed (${err.message}). Using keyword search only.`);
    return null;
  }
}

function cosine(a, b) {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// ---------------------------------------------------------------------------
// 5. Search: combine both rankings, keep only relevant passages
// ---------------------------------------------------------------------------
// A passage counts as relevant if its keyword score OR its meaning score passes these.
// Tune with Admin → Knowledge → "Test a question", which shows both scores.
const MIN_BM25 = Number(process.env.KB_MIN_KEYWORD_SCORE) || 1.2;
const MIN_COSINE = Number(process.env.KB_MIN_SIMILARITY) || 0.6;

export async function searchPolicies(query, { topK = 3 } = {}) {
  const idx = await getIndex();
  if (!idx.chunks.length) return [];
  const qTokens = tokenize(query);
  const kw = bm25(qTokens, idx);

  let sem = null;
  if (idx.chunks.some((c) => c.embedding?.length)) {
    const q = await embed([query]);
    if (q?.[0]) sem = idx.chunks.map((c) => (c.embedding?.length ? cosine(q[0], c.embedding) : 0));
  }

  // Reciprocal-rank fusion of the two rankings
  const rank = (scores) => {
    const order = scores.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0]);
    const r = new Array(scores.length);
    order.forEach(([, i], pos) => (r[i] = pos));
    return r;
  };
  const rk = rank(kw);
  const rs = sem ? rank(sem) : null;

  const results = idx.chunks
    .map((c, i) => ({
      chunk: c,
      keyword: kw[i],
      meaning: sem ? sem[i] : null,
      relevant: kw[i] >= MIN_BM25 || (sem && sem[i] >= MIN_COSINE),
      fused: 1 / (60 + rk[i]) + (rs ? 1 / (60 + rs[i]) : 0),
    }))
    .filter((r) => r.relevant)
    .sort((a, b) => b.fused - a.fused)
    .slice(0, topK);

  return results.map((r) => ({
    docId: String(r.chunk.docId),
    docTitle: r.chunk.docTitle,
    heading: r.chunk.heading,
    text: r.chunk.text,
    keywordScore: Math.round(r.keyword * 100) / 100,
    meaningScore: r.meaning === null ? null : Math.round(r.meaning * 100) / 100,
  }));
}

/** Text added to the system prompt so the model answers from the policies */
export function buildPolicyContext(passages) {
  if (!passages.length) return '';
  const body = passages
    .map((p, i) => `[${i + 1}] ${p.docTitle}${p.heading ? ' — ' + p.heading : ''}\n${p.text}`)
    .join('\n\n');
  return (
    'COMPANY POLICY EXCERPTS (official source):\n' +
    body +
    '\n\nAnswer the question using these excerpts. Quote numbers, days and amounts exactly as written. ' +
    'Mention which policy you used, e.g. "According to the Leave Policy…". ' +
    'If the excerpts do not answer the question, say you could not find it in the company policies and suggest asking HR. ' +
    'Never invent policy details.'
  );
}

// ---------------------------------------------------------------------------
// 6. Save a document: chunk it, embed passages, store
// ---------------------------------------------------------------------------
export async function indexDocument(doc) {
  await PolicyChunk.deleteMany({ docId: doc._id });
  const parts = chunkText(doc.text);
  // Embed in batches (title + heading help the meaning search)
  let vectors = [];
  for (let i = 0; i < parts.length; i += 16) {
    const batch = parts.slice(i, i + 16).map((p) => `${doc.title}. ${p.heading ? p.heading + '. ' : ''}${p.text}`);
    const v = await embed(batch);
    if (!v) {
      vectors = null;
      break;
    }
    vectors.push(...v);
  }
  if (parts.length) {
    await PolicyChunk.insertMany(
      parts.map((p, i) => ({
        docId: doc._id,
        docTitle: doc.title,
        index: p.index,
        heading: p.heading,
        text: p.text,
        ...(vectors ? { embedding: vectors[i] } : {}),
      }))
    );
  }
  doc.chunkCount = parts.length;
  doc.embedded = !!vectors && parts.length > 0;
  await doc.save();
  invalidateIndex();
  return doc;
}
