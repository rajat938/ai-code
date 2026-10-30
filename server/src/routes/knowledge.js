import { Router } from 'express';
import multer from 'multer';
import mongoose from 'mongoose';
import PolicyDoc from '../models/PolicyDoc.js';
import PolicyChunk from '../models/PolicyChunk.js';
import { requireAdmin } from '../middleware/auth.js';
import { config } from '../config.js';
import {
  fileType,
  extractText,
  cleanText,
  indexDocument,
  invalidateIndex,
  searchPolicies,
  embed,
} from '../services/knowledge.js';

const router = Router();
router.use(requireAdmin);
router.use((_req, res, next) => {
  if (mongoose.connection.readyState !== 1) return res.status(503).json({ message: 'Database is not connected.' });
  next();
});

const MAX_MB = 20;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 10 },
});

const titleFromFilename = (name) =>
  name
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150) || 'Untitled policy';

// List documents (without their full text)
router.get('/', async (_req, res) => {
  const docs = await PolicyDoc.find().sort({ updatedAt: -1 }).select('-text').lean();
  const chunks = await PolicyChunk.estimatedDocumentCount();
  res.json({ docs, totalPassages: chunks, embedModel: config.embedModel || '' });
});

router.get('/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Bad id' });
  const doc = await PolicyDoc.findById(req.params.id).lean();
  if (!doc) return res.status(404).json({ message: 'Not found' });
  res.json(doc);
});

// Upload one or more PDF / Word / text files
router.post('/upload', (req, res, next) => {
  upload.array('files', 10)(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `File is larger than ${MAX_MB} MB` : err.message;
      return res.status(400).json({ message: msg });
    }
    next();
  });
}, async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ message: 'No files received' });
  const results = [];
  for (const f of files) {
    const name = Buffer.from(f.originalname, 'latin1').toString('utf8'); // keep non-English file names intact
    const type = fileType(name, f.mimetype);
    if (!type) {
      results.push({ file: name, ok: false, message: 'Unsupported file type. Use PDF, Word (.docx) or .txt' });
      continue;
    }
    try {
      const text = await extractText(f.buffer, type);
      if (text.replace(/\s/g, '').length < 30) {
        results.push({
          file: name,
          ok: false,
          message:
            type === 'pdf'
              ? 'No text found. This PDF is probably a scanned image; export it as a text PDF or paste the text instead.'
              : 'No text found in this file.',
        });
        continue;
      }
      const doc = await PolicyDoc.create({
        title: (files.length === 1 && req.body?.title?.trim()) || titleFromFilename(name),
        filename: name,
        type,
        text,
        size: f.size,
        uploadedBy: req.admin?.username || '',
      });
      await indexDocument(doc);
      results.push({ file: name, ok: true, id: doc._id, title: doc.title, passages: doc.chunkCount, embedded: doc.embedded });
    } catch (err) {
      console.error('Upload failed:', name, err);
      results.push({ file: name, ok: false, message: `Could not read file: ${err.message}` });
    }
  }
  res.json({ results });
});

// Add a policy by typing/pasting text
router.post('/text', async (req, res) => {
  const title = String(req.body?.title || '').trim().slice(0, 150);
  const text = cleanText(String(req.body?.text || '').slice(0, 500000));
  if (!title) return res.status(400).json({ message: 'Title is required' });
  if (text.length < 30) return res.status(400).json({ message: 'Policy text is too short' });
  const doc = await PolicyDoc.create({ title, text, type: 'text', size: text.length, uploadedBy: req.admin?.username || '' });
  await indexDocument(doc);
  res.json(doc);
});

// Rename, enable/disable, or edit text
router.patch('/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Bad id' });
  const doc = await PolicyDoc.findById(req.params.id);
  if (!doc) return res.status(404).json({ message: 'Not found' });
  let reindex = false;
  if (typeof req.body?.title === 'string' && req.body.title.trim() && req.body.title.trim() !== doc.title) {
    doc.title = req.body.title.trim().slice(0, 150);
    reindex = true;
  }
  if (typeof req.body?.text === 'string') {
    const text = cleanText(req.body.text.slice(0, 500000));
    if (text.length < 30) return res.status(400).json({ message: 'Policy text is too short' });
    if (text !== doc.text) {
      doc.text = text;
      reindex = true;
    }
  }
  if (typeof req.body?.enabled === 'boolean') doc.enabled = req.body.enabled;
  await doc.save();
  if (reindex) await indexDocument(doc);
  else invalidateIndex();
  const out = doc.toObject();
  delete out.text;
  res.json(out);
});

router.delete('/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Bad id' });
  await PolicyChunk.deleteMany({ docId: req.params.id });
  await PolicyDoc.deleteOne({ _id: req.params.id });
  invalidateIndex();
  res.json({ ok: true });
});

// Re-process every document (e.g. after installing the embedding model)
router.post('/reindex', async (_req, res) => {
  const probe = await embed(['test']);
  const docs = await PolicyDoc.find();
  for (const d of docs) await indexDocument(d);
  res.json({ ok: true, documents: docs.length, meaningSearch: !!probe });
});

// Try a question: which passages would be given to the AI?
router.post('/search', async (req, res) => {
  const q = String(req.body?.query || '').trim();
  if (!q) return res.status(400).json({ message: 'Query is required' });
  const passages = await searchPolicies(q, { topK: Number(req.body?.topK) || 5 });
  res.json({ passages });
});

export default router;
