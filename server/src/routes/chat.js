import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import PromptLog from '../models/PromptLog.js';
import Conversation from '../models/Conversation.js';
import { config } from '../config.js';
import { streamChat, localModelList, aiServerModelList } from '../services/llm.js';
import { clientIdOf } from './conversations.js';
import { getSettings, checkPrompt, buildSystemPrompt, DEFAULTS } from '../services/policy.js';
import { searchPolicies, buildPolicyContext } from '../services/knowledge.js';

const router = Router();

const limiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
const dbUp = () => mongoose.connection.readyState === 1;

// Assistant name + notice shown to staff on the chat page
router.get('/policy', async (_req, res) => {
  const s = await getSettings().catch(() => ({}));
  res.json({ assistantName: s.assistantName || '', userNotice: s.userNotice || '' });
});

// Models staff can pick: Ollama models on this server + models on the private GPU AI server (if set up)
router.get('/models', async (_req, res) => {
  const serverModels = await aiServerModelList();
  let models = [];
  let message = '';
  try {
    models = await localModelList();
  } catch (err) {
    message = `Cannot reach Ollama at ${config.ollamaUrl}: ${err.cause?.code || err.message}`;
  }
  const all = [...models, ...serverModels];
  const def =
    all.find((m) => m === config.defaultModel || m === `${config.defaultModel}:latest`) || all[0] || config.defaultModel;
  if (!all.length && message) return res.status(502).json({ message, models: [], serverModels: [], defaultModel: def });
  res.json({ models, serverModels, serverName: config.aiServer.name, defaultModel: def });
});

/**
 * POST /api/chat  { prompt, model, conversationId? }   header: X-Client-Id
 * Streams the answer as plain text. Response headers:
 *   X-Conversation-Id  -> the chat this message belongs to (new one is created if none was given)
 */
router.post('/', limiter, async (req, res) => {
  const prompt = (req.body?.prompt || '').trim();
  const model = (req.body?.model || config.defaultModel).trim();
  const clientId = clientIdOf(req);
  if (!prompt) return res.status(400).json({ message: 'Prompt is required' });
  if (prompt.length > 8000) return res.status(400).json({ message: 'Prompt is too long (max 8000 chars)' });

  // ---- Load or create the conversation (skipped if MongoDB is down) ----
  let conv = null;
  if (dbUp() && clientId) {
    try {
      const id = req.body?.conversationId;
      if (id && mongoose.isValidObjectId(id)) {
        conv = await Conversation.findOne({ _id: id, clientId });
      }
      if (!conv) {
        conv = await Conversation.create({
          clientId,
          model,
          title: prompt.replace(/\s+/g, ' ').slice(0, 60),
        });
      }
    } catch (err) {
      console.warn('Could not load/create conversation:', err.message);
    }
  }

  // ---- Build the message list: last N messages as memory + the new prompt ----
  // ---- Company policy: settings, restricted-topic check, system prompt ----
  const settings = await getSettings().catch(() => ({ rules: [] }));
  const check = checkPrompt(prompt, settings);

  const all = conv?.messages || [];
  const history = [];
  for (let i = 0; i < all.length; i++) {
    const m = all[i];
    // skip refused exchanges (the user question that was blocked and its refusal)
    if (m.blocked || all[i + 1]?.blocked || !m.content || m.error) continue;
    history.push({ role: m.role, content: m.content });
  }
  // ---- Company policy documents: find passages that answer this question ----
  let passages = [];
  const kbOn = settings.kbEnabled !== false;
  if (kbOn && !check.blocked) {
    // Short follow-ups ("and for interns?") are searched together with the previous question
    const lastUser = [...all].reverse().find((m) => m.role === 'user' && !m.blocked)?.content || '';
    const query = prompt.split(/\s+/).length < 8 && lastUser ? `${prompt} ${lastUser}` : prompt;
    try {
      passages = await searchPolicies(query, { topK: settings.kbTopK || 3 });
    } catch (err) {
      console.warn('Policy search failed:', err.message);
    }
  }
  const sources = [...new Map(passages.map((p) => [p.docId, { docId: p.docId, title: p.docTitle }])).values()];
  const strictNoMatch = kbOn && settings.kbStrict && !check.blocked && passages.length === 0;

  const systemPrompt = [buildSystemPrompt(settings), buildPolicyContext(passages)].filter(Boolean).join('\n\n');
  const messages = [
    ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
    ...history.slice(-config.historyLimit),
    { role: 'user', content: prompt },
  ];

  // ---- Admin log entry ----
  let log;
  try {
    if (!dbUp()) throw new Error('MongoDB not connected');
    log = await PromptLog.create({
      prompt,
      model,
      clientId: clientId || '',
      conversationId: conv?._id,
      ...(check.blocked ? { status: 'blocked', blockedRule: check.rule, response: check.message } : {}),
      sources,
      ip: req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress,
      userAgent: req.headers['user-agent'],
    });
  } catch (err) {
    console.warn('Could not save prompt log:', err.message);
    log = { save: async () => {} };
  }

  const started = Date.now();
  let full = '';
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  async function saveConversation(errorMsg = '', blocked = false) {
    if (!conv) return;
    try {
      conv.messages.push({ role: 'user', content: prompt });
      conv.messages.push({
        role: 'assistant',
        content: full,
        error: errorMsg,
        blocked,
        sources: blocked ? [] : sources,
        durationMs: Date.now() - started,
      });
      conv.model = model;
      await conv.save();
    } catch (err) {
      console.warn('Could not save conversation:', err.message);
    }
  }

  // ---- Blocked by a restricted-topic rule: answer with the refusal, never call the model ----
  if (check.blocked) {
    full = check.message;
    await saveConversation('', true);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Blocked', '1');
    if (conv) res.setHeader('X-Conversation-Id', String(conv._id));
    if (log._id) res.setHeader('X-Log-Id', String(log._id));
    return res.end(full);
  }

  // ---- "Only answer from policy documents" is on and nothing matched ----
  if (strictNoMatch) {
    full = settings.kbNotFoundMessage || DEFAULTS.kbNotFoundMessage;
    log.response = full;
    log.status = 'success';
    log.error = 'No matching policy passage (strict mode)';
    await log.save().catch(() => {});
    await saveConversation();
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    if (conv) res.setHeader('X-Conversation-Id', String(conv._id));
    return res.end(full);
  }

  try {
    const stats = await streamChat({
      model,
      messages,
      signal: controller.signal,
      onOpen: () => {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Accel-Buffering', 'no'); // stop nginx buffering so the answer streams
        if (conv) res.setHeader('X-Conversation-Id', String(conv._id));
        if (log._id) res.setHeader('X-Log-Id', String(log._id));
        if (sources.length) res.setHeader('X-Sources', encodeURIComponent(JSON.stringify(sources)));
        res.flushHeaders();
      },
      onText: (piece) => {
        full += piece;
        res.write(piece);
      },
    });
    const finalStats = { prompt_eval_count: stats.promptTokens, eval_count: stats.responseTokens };

    log.response = full;
    log.status = 'success';
    log.durationMs = Date.now() - started;
    log.promptTokens = finalStats.prompt_eval_count || 0;
    log.responseTokens = finalStats.eval_count || 0;
    await log.save().catch((e) => console.warn('Could not save prompt log:', e.message));
    await saveConversation();
    res.end();
  } catch (err) {
    const message = err.name === 'AbortError' ? 'Stopped by user' : err.message;
    log.response = full;
    log.status = err.name === 'AbortError' && full ? 'success' : 'error';
    log.error = message;
    log.durationMs = Date.now() - started;
    await log.save().catch(() => {});
    await saveConversation(err.name === 'AbortError' ? '' : message);
    if (!res.headersSent) {
      if (conv) res.setHeader('X-Conversation-Id', String(conv._id));
      res.status(502).json({ message, conversationId: conv?._id });
    } else if (!res.writableEnded) {
      res.end(`\n\n[Error: ${message}]`);
    }
  }
});

export default router;
