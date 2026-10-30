// Talks to the AI models. Everything stays inside your own network:
//  1. Ollama on this server (always available)
//  2. Optionally, a GPU "AI server" on your private network that speaks the
//     OpenAI-compatible API (vLLM, SGLang, llama.cpp server, LM Studio, ...).
//     Its address MUST be a private/local address: public internet addresses are refused.
import dns from 'dns/promises';
import net from 'net';
import { config, ollamaOptions } from '../config.js';

// ===========================================================================
// Private-network guard
// ===========================================================================
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT / VPNs like Tailscale
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
    return v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
  }
  return false;
}

/** Throws unless every address the URL points to is on a private network */
export async function assertPrivateUrl(url) {
  let host;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    throw new Error(`Invalid AI server address: ${url}`);
  }
  if (net.isIP(host)) {
    if (!isPrivateIp(host)) throw new Error(`Refused: ${host} is a public internet address. Only private-network AI servers are allowed.`);
    return;
  }
  const addrs = await dns.lookup(host, { all: true }).catch(() => {
    throw new Error(`Cannot find the AI server "${host}" on the network.`);
  });
  const pub = addrs.find((a) => !isPrivateIp(a.address));
  if (pub) throw new Error(`Refused: "${host}" points to a public internet address (${pub.address}). Only private-network AI servers are allowed.`);
}

// Re-check the address every few minutes (in case DNS changes)
let guardOkUntil = 0;
async function guardAiServer() {
  if (Date.now() < guardOkUntil) return;
  await assertPrivateUrl(config.aiServer.url);
  guardOkUntil = Date.now() + 5 * 60 * 1000;
}

// ===========================================================================
// Model lists
// ===========================================================================
export const aiServerConfigured = () => !!config.aiServer.url;

export async function localModelList() {
  const r = await fetch(`${config.ollamaUrl}/api/tags`);
  if (!r.ok) throw new Error(`Ollama responded ${r.status}`);
  const data = await r.json();
  return (data.models || []).map((m) => m.name);
}

let serverModels = { list: [], at: 0, error: '' };

/** Models available on the GPU AI server (cached for 60 s) */
export async function aiServerModelList({ fresh = false } = {}) {
  if (!aiServerConfigured()) return [];
  if (!fresh && Date.now() - serverModels.at < 60_000) return serverModels.list;
  try {
    await guardAiServer();
    let list = config.aiServer.models;
    if (!list.length) {
      const r = await fetch(`${config.aiServer.url}/models`, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) throw new Error(`responded ${r.status}`);
      const data = await r.json();
      list = (data.data || []).map((m) => m.id).filter(Boolean);
    }
    serverModels = { list, at: Date.now(), error: '' };
  } catch (err) {
    serverModels = { list: [], at: Date.now(), error: err.message };
  }
  return serverModels.list;
}

export const aiServerError = () => serverModels.error;

export async function isAiServerModel(model) {
  return (await aiServerModelList()).includes(model);
}

function authHeaders() {
  return config.aiServer.apiKey ? { Authorization: `Bearer ${config.aiServer.apiKey}` } : {};
}

// ===========================================================================
// Streaming chat. onOpen() once the model accepted the request,
// onText(piece) for every piece of the answer; returns token counts.
// ===========================================================================
export async function streamChat({ model, messages, signal, onOpen, onText }) {
  return (await isAiServerModel(model))
    ? streamAiServer({ model, messages, signal, onOpen, onText })
    : streamOllama({ model, messages, signal, onOpen, onText });
}

async function streamOllama({ model, messages, signal, onOpen, onText }) {
  let r;
  try {
    r = await fetch(`${config.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true, keep_alive: config.keepAlive, options: ollamaOptions() }),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    if (err.cause?.code === 'ECONNREFUSED' || err.cause?.code === 'ENOTFOUND') {
      throw new Error(`Cannot reach Ollama at ${config.ollamaUrl}. Is Ollama running? (try: ollama serve)`);
    }
    throw err;
  }
  if (!r.ok || !r.body) {
    const text = await r.text().catch(() => '');
    let msg = text;
    try {
      msg = JSON.parse(text).error || text;
    } catch {}
    if (r.status === 404) msg += ` — run: ollama pull ${model}`;
    throw new Error(`Ollama error ${r.status}: ${msg}`);
  }
  onOpen?.();

  const stats = { promptTokens: 0, responseTokens: 0 };
  const think = thinkFilter(onText);
  for await (const line of lines(r.body)) {
    if (!line.trim()) continue;
    const data = JSON.parse(line);
    if (data.error) throw new Error(data.error);
    if (data.message?.content) think.push(data.message.content);
    if (data.done) {
      stats.promptTokens = data.prompt_eval_count || 0;
      stats.responseTokens = data.eval_count || 0;
    }
  }
  think.end();
  return stats;
}

async function streamAiServer({ model, messages, signal, onOpen, onText }) {
  const s = config.aiServer;
  await guardAiServer();

  // Time limit only for the answer to START (a long answer may stream longer)
  const startCtrl = new AbortController();
  const timer = setTimeout(() => startCtrl.abort(), s.timeoutMs);
  const onUserAbort = () => startCtrl.abort();
  signal?.addEventListener('abort', onUserAbort);

  let r;
  try {
    r = await fetch(`${s.url}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: s.maxTokens,
      }),
      signal: startCtrl.signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    if (err.name === 'AbortError') throw new Error(`${s.name} did not start answering within ${s.timeoutMs / 1000}s.`);
    throw new Error(`Cannot reach ${s.name} at ${s.url}: ${err.cause?.code || err.message}. Is the AI server running?`);
  } finally {
    clearTimeout(timer);
  }
  if (!r.ok || !r.body) {
    const text = await r.text().catch(() => '');
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      msg = j.error?.message || j.message || j.detail || msg;
    } catch {}
    if (r.status === 401) msg = 'API key rejected. Check LOCAL_AI_SERVER_API_KEY in server/.env';
    throw new Error(`${s.name} error ${r.status}: ${msg}`);
  }
  onOpen?.();

  const stats = { promptTokens: 0, responseTokens: 0 };
  const think = thinkFilter(onText);
  try {
    for await (const line of lines(r.body)) {
      const l = line.trim();
      if (!l.startsWith('data:')) continue;
      const payload = l.slice(5).trim();
      if (payload === '[DONE]') break;
      let data;
      try {
        data = JSON.parse(payload);
      } catch {
        continue;
      }
      if (data.error) throw new Error(`${s.name}: ${data.error.message || 'error'}`);
      // Reasoning models send their thinking separately (reasoning_content); only the answer is shown
      const piece = data.choices?.[0]?.delta?.content;
      if (piece) think.push(piece);
      if (data.usage) {
        stats.promptTokens = data.usage.prompt_tokens || 0;
        stats.responseTokens = data.usage.completion_tokens || 0;
      }
    }
  } finally {
    signal?.removeEventListener('abort', onUserAbort);
  }
  think.end();
  return stats;
}

// ===========================================================================
// Helpers
// ===========================================================================

// Some reasoning models write their thinking inline as <think>...</think>.
// This hides it from staff and only passes the real answer through.
function thinkFilter(onText) {
  let buf = '';
  let inThink = false;
  let started = false;
  const flush = (final) => {
    while (buf) {
      if (inThink) {
        const end = buf.indexOf('</think>');
        if (end === -1) {
          if (final) buf = '';
          else buf = buf.slice(-8); // keep a tail in case "</think>" is split across pieces
          return;
        }
        buf = buf.slice(end + 8).replace(/^\s+/, '');
        inThink = false;
        continue;
      }
      const start = buf.indexOf('<think>');
      if (start === -1) {
        // hold back a few chars that might be the start of "<think>"
        const keep = final ? 0 : Math.min(6, buf.length);
        const out = buf.slice(0, buf.length - keep);
        buf = buf.slice(buf.length - keep);
        if (out && (started || out.trim())) {
          started = true;
          onText(out);
        }
        return;
      }
      if (start > 0) {
        started = true;
        onText(buf.slice(0, start));
      }
      buf = buf.slice(start + 7);
      inThink = true;
    }
  };
  return {
    push(t) {
      buf += t;
      flush(false);
    },
    end() {
      flush(true);
    },
  };
}

async function* lines(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const parts = buffer.split('\n');
    buffer = parts.pop();
    yield* parts;
  }
  if (buffer) yield buffer;
}
