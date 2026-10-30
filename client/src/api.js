const BASE = import.meta.env.VITE_API_URL || '';

// ---- Small wrapper around localStorage that never throws (private mode etc.) ----
export const storage = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {}
  },
};

export const tokenStore = {
  get: () => storage.get('adminToken'),
  set: (t) => storage.set('adminToken', t),
  clear: () => storage.remove('adminToken'),
};

// ---- Anonymous id for this browser, so each user sees only their own chats ----
function makeId() {
  if (window.crypto?.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
export function getClientId() {
  let id = storage.get('clientId');
  if (!id) {
    id = makeId();
    storage.set('clientId', id);
  }
  return id;
}

const BACKEND_DOWN =
  'Cannot reach the backend server. Make sure it is running on port 5000 and check its logs for errors.';

// Turn a failed response into a readable message
async function errorFrom(res) {
  const text = await res.text().catch(() => '');
  try {
    const data = JSON.parse(text);
    if (data.message) return data.message;
  } catch {}
  // The dev proxy returns an empty 500/502/504 when the backend is not running
  if ([500, 502, 503, 504].includes(res.status) && !text.trim()) return BACKEND_DOWN;
  return `Request failed (${res.status})${text ? ': ' + text.slice(0, 200) : ''}`;
}

async function safeFetch(url, options) {
  try {
    return await fetch(url, options);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new Error(BACKEND_DOWN);
  }
}

async function request(path, options = {}, auth = false) {
  const headers = { 'Content-Type': 'application/json', 'X-Client-Id': getClientId(), ...(options.headers || {}) };
  if (auth) headers.Authorization = `Bearer ${tokenStore.get()}`;
  const res = await safeFetch(BASE + path, { ...options, headers });
  if (res.status === 401 && auth) {
    tokenStore.clear();
    window.location.href = '/admin/login';
    throw new Error('Session expired');
  }
  if (!res.ok) throw new Error(await errorFrom(res));
  return res.json();
}

export const api = {
  models: () => request('/api/chat/models'),
  health: () => request('/api/health'),
  policy: () => request('/api/chat/policy'),

  // ---- Chat history for this browser ----
  conversations: () => request('/api/conversations'),
  conversation: (id) => request(`/api/conversations/${id}`),
  renameConversation: (id, title) =>
    request(`/api/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  deleteConversation: (id) => request(`/api/conversations/${id}`, { method: 'DELETE' }),

  /**
   * Sends a prompt and streams the answer.
   * onStart(conversationId) is called once the server has created/loaded the chat.
   * onChunk(text) is called for every piece of the answer.
   */
  async sendPrompt({ prompt, model, conversationId }, { onStart, onChunk }, signal) {
    const res = await safeFetch(BASE + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Id': getClientId() },
      body: JSON.stringify({ prompt, model, conversationId }),
      signal,
    });
    const convId = res.headers.get('X-Conversation-Id');
    const blocked = res.headers.get('X-Blocked') === '1';
    let sources = [];
    try {
      sources = JSON.parse(decodeURIComponent(res.headers.get('X-Sources') || '[]'));
    } catch {}
    if (convId || blocked || sources.length) onStart?.(convId, { blocked, sources });
    if (!res.ok) throw new Error(await errorFrom(res));
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk(decoder.decode(value, { stream: true }));
    }
  },

  // ---- Admin ----
  login: (username, password) =>
    request('/api/admin/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  stats: () => request('/api/admin/stats', {}, true),
  logs: (params) => request('/api/admin/logs?' + new URLSearchParams(params), {}, true),
  getSettings: () => request('/api/admin/settings', {}, true),
  saveSettings: (data) => request('/api/admin/settings', { method: 'PUT', body: JSON.stringify(data) }, true),
  testPrompt: (prompt, settings) =>
    request('/api/admin/settings/test', { method: 'POST', body: JSON.stringify({ prompt, settings }) }, true),
  // ---- Policy documents ----
  kbList: () => request('/api/admin/knowledge', {}, true),
  kbGet: (id) => request(`/api/admin/knowledge/${id}`, {}, true),
  kbAddText: (title, text) =>
    request('/api/admin/knowledge/text', { method: 'POST', body: JSON.stringify({ title, text }) }, true),
  kbUpdate: (id, data) => request(`/api/admin/knowledge/${id}`, { method: 'PATCH', body: JSON.stringify(data) }, true),
  kbDelete: (id) => request(`/api/admin/knowledge/${id}`, { method: 'DELETE' }, true),
  kbSearch: (query) => request('/api/admin/knowledge/search', { method: 'POST', body: JSON.stringify({ query }) }, true),
  kbReindex: () => request('/api/admin/knowledge/reindex', { method: 'POST' }, true),
  async kbUpload(files) {
    const form = new FormData();
    for (const f of files) form.append('files', f);
    const res = await safeFetch(BASE + '/api/admin/knowledge/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenStore.get()}` },
      body: form,
    });
    if (res.status === 413) throw new Error('File too large for the web server. Increase client_max_body_size in nginx.');
    if (!res.ok) throw new Error(await errorFrom(res));
    return res.json();
  },
  aiServers: () => request('/api/admin/ai-servers', {}, true),
  deleteLog: (id) => request(`/api/admin/logs/${id}`, { method: 'DELETE' }, true),

  async exportCsv(params) {
    const res = await fetch(BASE + '/api/admin/export?' + new URLSearchParams(params), {
      headers: { Authorization: `Bearer ${tokenStore.get()}` },
    });
    if (!res.ok) throw new Error('Export failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'prompt-logs.csv';
    a.click();
    URL.revokeObjectURL(url);
  },
};
