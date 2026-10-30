import { Router } from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import PromptLog from '../models/PromptLog.js';
import Conversation from '../models/Conversation.js';
import { config } from '../config.js';
import { requireAdmin } from '../middleware/auth.js';
import { localModelList, aiServerConfigured, aiServerModelList, aiServerError } from '../services/llm.js';
import Settings from '../models/Settings.js';
import { getSettings, clearSettingsCache, checkPrompt, buildSystemPrompt, validateRules, DEFAULTS } from '../services/policy.js';

const router = Router();

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username !== config.adminUsername || password !== config.adminPassword) {
    return res.status(401).json({ message: 'Invalid username or password' });
  }
  const token = jwt.sign({ username }, config.jwtSecret, { expiresIn: '12h' });
  res.json({ token, username });
});

// Everything below needs a valid admin token
router.use(requireAdmin);

router.get('/stats', async (_req, res) => {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const since = new Date(Date.now() - 13 * 24 * 60 * 60 * 1000);
  since.setHours(0, 0, 0, 0);

  const [total, today, errors, avg, byModel, daily, users, conversations, blocked] = await Promise.all([
    PromptLog.countDocuments(),
    PromptLog.countDocuments({ createdAt: { $gte: startOfDay } }),
    PromptLog.countDocuments({ status: 'error' }),
    PromptLog.aggregate([{ $match: { status: 'success' } }, { $group: { _id: null, avg: { $avg: '$durationMs' } } }]),
    PromptLog.aggregate([{ $group: { _id: '$model', count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
    PromptLog.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    PromptLog.distinct('clientId', { clientId: { $nin: ['', null] } }).then((a) => a.length),
    Conversation.estimatedDocumentCount(),
    PromptLog.countDocuments({ status: 'blocked' }),
  ]);

  res.json({
    total,
    today,
    errors,
    avgDurationMs: Math.round(avg[0]?.avg || 0),
    users,
    conversations,
    blocked,
    byModel: byModel.map((m) => ({ model: m._id, count: m.count })),
    daily: daily.map((d) => ({ date: d._id, count: d.count })),
  });
});

function buildFilter(query) {
  const filter = {};
  if (query.q) {
    const rx = new RegExp(String(query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ prompt: rx }, { response: rx }];
  }
  if (query.status) filter.status = query.status;
  if (query.model) filter.model = query.model;
  if (query.blockedRule) filter.blockedRule = String(query.blockedRule);
  if (query.clientId) filter.clientId = String(query.clientId);
  if (query.conversationId && mongoose.isValidObjectId(query.conversationId)) filter.conversationId = query.conversationId;
  if (query.from || query.to) {
    filter.createdAt = {};
    if (query.from) filter.createdAt.$gte = new Date(query.from);
    if (query.to) {
      const to = new Date(query.to);
      to.setHours(23, 59, 59, 999);
      filter.createdAt.$lte = to;
    }
  }
  return filter;
}

router.get('/logs', async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const filter = buildFilter(req.query);

  const [items, total] = await Promise.all([
    PromptLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    PromptLog.countDocuments(filter),
  ]);
  res.json({ items, total, page, pages: Math.max(1, Math.ceil(total / limit)) });
});

router.get('/logs/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Bad id' });
  const log = await PromptLog.findById(req.params.id).lean();
  if (!log) return res.status(404).json({ message: 'Not found' });
  res.json(log);
});

router.delete('/logs/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Bad id' });
  await PromptLog.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

// ---- Status of the AI model servers (read-only; configured in server/.env) ----
router.get('/ai-servers', async (_req, res) => {
  let ollama = { ok: false, models: [], error: '' };
  try {
    ollama = { ok: true, models: await localModelList(), error: '' };
  } catch (err) {
    ollama.error = err.cause?.code || err.message;
  }
  let aiServer = null;
  if (aiServerConfigured()) {
    const models = await aiServerModelList({ fresh: true });
    aiServer = {
      name: config.aiServer.name,
      url: config.aiServer.url,
      ok: models.length > 0,
      models,
      error: models.length ? '' : aiServerError(),
      maxTokens: config.aiServer.maxTokens,
    };
  }
  res.json({ ollama: { url: config.ollamaUrl, ...ollama }, aiServer, defaultModel: config.defaultModel });
});

// ---- Company policy & restricted topics ----
const clean = (v, max) => String(v ?? '').slice(0, max);

router.get('/settings', async (_req, res) => {
  const s = await getSettings({ fresh: true });
  res.json({ ...s, defaults: DEFAULTS });
});

router.put('/settings', async (req, res) => {
  const b = req.body || {};
  const rules = (Array.isArray(b.rules) ? b.rules : []).slice(0, 200).map((r) => ({
    name: clean(r.name, 100).trim(),
    keywords: (Array.isArray(r.keywords) ? r.keywords : String(r.keywords || '').split(','))
      .map((k) => clean(k, 100).trim())
      .filter(Boolean)
      .slice(0, 200),
    pattern: clean(r.pattern, 500).trim(),
    message: clean(r.message, 1000).trim(),
    enabled: r.enabled !== false,
  }));
  const err = validateRules(rules);
  if (err) return res.status(400).json({ message: err });

  const doc = await Settings.findOneAndUpdate(
    { key: 'global' },
    {
      assistantName: clean(b.assistantName, 80).trim(),
      userNotice: clean(b.userNotice, 1000),
      systemPrompt: clean(b.systemPrompt, 8000),
      defaultBlockMessage: clean(b.defaultBlockMessage, 1000),
      rules,
      ...(typeof b.kbEnabled === 'boolean' ? { kbEnabled: b.kbEnabled } : {}),
      ...(typeof b.kbStrict === 'boolean' ? { kbStrict: b.kbStrict } : {}),
      ...(b.kbTopK !== undefined ? { kbTopK: Math.min(6, Math.max(1, Number(b.kbTopK) || 3)) } : {}),
      ...(b.kbNotFoundMessage !== undefined ? { kbNotFoundMessage: clean(b.kbNotFoundMessage, 1000) } : {}),
      updatedBy: req.admin?.username || '',
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();
  clearSettingsCache();
  res.json(doc);
});

// Try a prompt against the (unsaved) settings from the editor
router.post('/settings/test', async (req, res) => {
  const b = req.body || {};
  const settings = b.settings || (await getSettings({ fresh: true }));
  const err = validateRules(settings.rules || []);
  if (err) return res.status(400).json({ message: err });
  const result = checkPrompt(String(b.prompt || ''), settings);
  res.json({ ...result, systemPrompt: buildSystemPrompt(settings) });
});

// Download all (or filtered) logs as CSV
router.get('/export', async (req, res) => {
  const logs = await PromptLog.find(buildFilter(req.query)).sort({ createdAt: -1 }).lean();
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['createdAt', 'user', 'conversation', 'model', 'status', 'blockedRule', 'durationMs', 'ip', 'prompt', 'response', 'error'].join(',')];
  for (const l of logs) {
    rows.push(
      [l.createdAt?.toISOString(), l.clientId, l.conversationId, l.model, l.status, l.blockedRule, l.durationMs, l.ip, l.prompt, l.response, l.error].map(esc).join(',')
    );
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="prompt-logs.csv"');
  res.send(rows.join('\n'));
});

export default router;
