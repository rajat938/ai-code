import mongoose from 'mongoose';
import Settings from '../models/Settings.js';

// ---------------------------------------------------------------------------
// Defaults used the first time the app starts. EXAMPLES ONLY — edit them in
// Admin → Policies to match your company.
// ---------------------------------------------------------------------------
export const DEFAULTS = {
  assistantName: 'Company Assistant',
  userNotice:
    'For internal use only. Do not paste passwords, customer data or confidential documents. Conversations are logged and may be reviewed.',
  systemPrompt: [
    'You are the internal AI assistant for our company employees.',
    'Follow these company policies at all times:',
    '1. Be professional, polite and concise. Answer in the language the user writes in.',
    '2. Never reveal or guess confidential information: salaries, employee personal details, passwords, API keys, client data or unreleased plans.',
    '3. Do not give legal, medical or financial advice. Suggest contacting the relevant department (HR, Legal, Finance) instead.',
    '4. Do not help with hacking, bypassing security, or anything that breaks the law or company IT policy.',
    '5. For HR questions (leave, payroll, appraisals), direct employees to the HR team.',
    '6. If you are not sure about a company-specific fact, say you do not know rather than inventing it.',
  ].join('\n'),
  defaultBlockMessage:
    'Sorry, I can’t help with that topic under company policy. Please contact the relevant team (HR, IT or your manager) for help.',
  rules: [
    {
      name: 'Salary & compensation',
      keywords: ['salary', 'salaries', 'payroll', 'pay slip', 'payslip', 'ctc', 'compensation', 'increment', 'appraisal rating'],
      message: 'Questions about salaries, payroll or compensation can’t be answered here. Please contact HR directly.',
      enabled: true,
    },
    {
      name: 'Employee personal data',
      keywords: ['aadhaar', 'aadhar', 'pan card', 'bank account number', 'home address of', 'phone number of', 'personal details of'],
      message: 'I can’t share or look up personal information about employees.',
      enabled: true,
    },
    {
      name: 'Hacking & security bypass',
      keywords: ['hack', 'hacking', 'malware', 'ransomware', 'keylogger', 'phishing', 'bypass security', 'bypass firewall', 'crack password', 'disable antivirus'],
      message: 'Requests related to hacking or bypassing security are not allowed. Contact the IT team for security questions.',
      enabled: true,
    },
  ],
};

// ---------------------------------------------------------------------------
// Settings cache (so we don't hit MongoDB on every prompt)
// ---------------------------------------------------------------------------
let cache = null;
let cacheAt = 0;
const TTL = 30 * 1000;

export async function getSettings({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cacheAt < TTL) return cache;
  if (mongoose.connection.readyState !== 1) return cache || { ...DEFAULTS, _fallback: true };
  let doc = await Settings.findOne({ key: 'global' }).lean();
  if (!doc) {
    // First run: save the defaults so admins can edit them
    doc = (await Settings.create({ key: 'global', ...DEFAULTS })).toObject();
  }
  cache = doc;
  cacheAt = Date.now();
  return doc;
}

export function clearSettingsCache() {
  cache = null;
  cacheAt = 0;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------
const escape = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
// Letters/numbers/marks in any language (works for Hindi etc.)
const B = '[\\p{L}\\p{N}\\p{M}]';

// "pay slip" -> matches "pay slip", "Pay   Slip"; "salar*" -> "salary", "salaries"
function keywordRegex(kw) {
  const body = escape(kw.trim().toLowerCase()).replace(/\*/g, `${B}*`).replace(/\s+/g, '\\s+');
  return new RegExp(`(?<!${B})${body}(?!${B})`, 'iu');
}

export function normalize(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/[​-‍﻿]/g, '') // zero-width characters people use to dodge filters
    .toLowerCase();
}

/** Returns { blocked: false } or { blocked: true, rule, matched, message } */
export function checkPrompt(prompt, settings) {
  const text = normalize(prompt);
  for (const rule of settings.rules || []) {
    if (!rule.enabled) continue;
    for (const kw of rule.keywords || []) {
      if (!kw || !kw.trim()) continue;
      const m = text.match(keywordRegex(kw));
      if (m) return blockResult(rule, m[0], settings);
    }
    if (rule.pattern) {
      try {
        const m = text.match(new RegExp(rule.pattern, 'iu'));
        if (m) return blockResult(rule, m[0], settings);
      } catch {
        // invalid regex saved by an admin: ignore it (the admin UI validates too)
      }
    }
  }
  return { blocked: false };
}

function blockResult(rule, matched, settings) {
  return {
    blocked: true,
    rule: rule.name,
    matched,
    message: rule.message || settings.defaultBlockMessage || DEFAULTS.defaultBlockMessage,
  };
}

/** System prompt sent to the model: company policies + the restricted topics */
export function buildSystemPrompt(settings) {
  const parts = [];
  if (settings.assistantName) parts.push(`Your name is ${settings.assistantName}.`);
  if (settings.systemPrompt?.trim()) parts.push(settings.systemPrompt.trim());
  const topics = (settings.rules || []).filter((r) => r.enabled).map((r) => r.name);
  if (topics.length) {
    parts.push(
      `Restricted topics you must politely refuse to discuss: ${topics.join('; ')}. ` +
        `If asked about them, reply: "${settings.defaultBlockMessage || DEFAULTS.defaultBlockMessage}"`
    );
  }
  return parts.join('\n\n');
}

export function validateRules(rules) {
  if (!Array.isArray(rules)) return 'rules must be a list';
  for (const r of rules) {
    if (!r.name || !String(r.name).trim()) return 'Every rule needs a name';
    if (r.pattern) {
      try {
        new RegExp(r.pattern, 'iu');
      } catch (e) {
        return `Rule "${r.name}": invalid pattern (${e.message})`;
      }
    }
  }
  return null;
}
