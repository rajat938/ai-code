import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { api, storage } from '../api.js';

// What we keep in the browser so a refresh restores the screen instantly,
// even before the server answers (and even if the database is down).
const CACHE_KEY = 'chatCache';
const ACTIVE_KEY = 'activeConversationId';
const MODEL_KEY = 'selectedModel';

// Convert server messages ({role:'assistant', content}) to UI messages ({role:'ai', text})
const fromServer = (msgs = []) =>
  msgs.map((m) => ({
    role: m.role === 'assistant' ? 'ai' : 'user',
    text: m.content || '',
    error: m.error || '',
    blocked: !!m.blocked,
    sources: m.sources || [],
  }));

function timeAgo(date) {
  const s = Math.floor((Date.now() - new Date(date)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(date).toLocaleDateString();
}

export default function ChatPage({ notice = '', assistantName = '' }) {
  const cached = storage.get(CACHE_KEY, {});
  const [models, setModels] = useState([]); // models installed in the local Ollama
  const [serverModels, setServerModels] = useState([]); // models on the private GPU AI server
  const [serverName, setServerName] = useState('');
  const [model, setModel] = useState(storage.get(MODEL_KEY, ''));
  const [prompt, setPrompt] = useState('');
  const [conversationId, setConversationId] = useState(storage.get(ACTIVE_KEY, null));
  const [messages, setMessages] = useState(cached.id === storage.get(ACTIVE_KEY, null) ? cached.messages || [] : []);
  const [conversations, setConversations] = useState([]);
  const [historyError, setHistoryError] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const [health, setHealth] = useState(null);
  const abortRef = useRef(null);
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const stickToBottom = useRef(true);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [copied, setCopied] = useState(-1);

  // ---- Persist what's on screen so a refresh brings it back ----
  useEffect(() => {
    storage.set(ACTIVE_KEY, conversationId);
    storage.set(CACHE_KEY, { id: conversationId, messages: messages.slice(-100) });
  }, [conversationId, messages]);

  useEffect(() => {
    if (model) storage.set(MODEL_KEY, model);
  }, [model]);

  // ---- Health banner ----
  useEffect(() => {
    const check = () =>
      api
        .health()
        .then(setHealth)
        .catch((e) => setHealth({ backendError: e.message }));
    check();
    const t = setInterval(check, 15000);
    return () => clearInterval(t);
  }, []);

  // ---- Models ----
  useEffect(() => {
    api
      .models()
      .then((d) => {
        const all = [...d.models, ...(d.serverModels || [])];
        setModels(d.models);
        setServerModels(d.serverModels || []);
        setServerName(d.serverName || 'GPU server');
        setModel((current) =>
          current && all.includes(current) ? current : all.includes(d.defaultModel) ? d.defaultModel : all[0] || d.defaultModel
        );
      })
      .catch((e) => setError(e.message));
  }, []);

  // ---- Chat list for this browser ----
  const loadConversations = useCallback(async () => {
    try {
      const { items } = await api.conversations();
      setConversations(items);
      setHistoryError('');
      return items;
    } catch (e) {
      setHistoryError(e.message);
      return null;
    }
  }, []);

  // On first load: fetch the list and the active chat from the server
  useEffect(() => {
    (async () => {
      const items = await loadConversations();
      const active = storage.get(ACTIVE_KEY, null);
      if (!active || !items) return;
      if (!items.some((c) => c._id === active)) {
        // Chat was deleted (or belongs to another browser): start fresh
        setConversationId(null);
        setMessages([]);
        return;
      }
      try {
        const conv = await api.conversation(active);
        setMessages(fromServer(conv.messages));
      } catch {}
    })();
  }, [loadConversations]);

  // Scroll the message list (not the page). While an answer streams, only follow it
  // if the user is already at the bottom, so they can scroll up and read.
  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  function onScroll() {
    const el = listRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickToBottom.current = atBottom;
    setShowScrollDown(!atBottom);
  }

  function scrollToBottom() {
    const el = listRef.current;
    if (!el) return;
    stickToBottom.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }

  // Grow the prompt box with its content (up to the CSS max-height)
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [prompt]);

  async function copyText(text, i) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const t = document.createElement('textarea');
      t.value = text;
      document.body.appendChild(t);
      t.select();
      document.execCommand('copy');
      t.remove();
    }
    setCopied(i);
    setTimeout(() => setCopied(-1), 1500);
  }

  // Timer shown while waiting, so a slow CPU server doesn't look frozen
  useEffect(() => {
    if (!loading) return;
    const start = Date.now();
    setElapsed(0);
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(t);
  }, [loading]);

  async function openConversation(id) {
    if (loading || id === conversationId) return setSidebarOpen(false);
    setError('');
    setSidebarOpen(false);
    setConversationId(id);
    setMessages([]);
    stickToBottom.current = true;
    try {
      const conv = await api.conversation(id);
      setMessages(fromServer(conv.messages));
      if (conv.model && (models.includes(conv.model) || serverModels.includes(conv.model))) setModel(conv.model);
    } catch (e) {
      setError(e.message);
    }
  }

  function newChat() {
    if (loading) return;
    setConversationId(null);
    setMessages([]);
    setError('');
    setSidebarOpen(false);
  }

  async function removeConversation(id, e) {
    e.stopPropagation();
    if (!confirm('Delete this chat?')) return;
    try {
      await api.deleteConversation(id);
      setConversations((list) => list.filter((c) => c._id !== id));
      if (id === conversationId) newChat();
    } catch (err) {
      setError(err.message);
    }
  }

  async function submit(e) {
    e?.preventDefault();
    const text = prompt.trim();
    if (!text || loading) return;
    setError('');
    setPrompt('');
    setLoading(true);
    stickToBottom.current = true;
    setMessages((m) => [...m, { role: 'user', text }, { role: 'ai', text: '' }]);

    // Batch incoming text and paint at most ~20 times/second (smoother on slow PCs)
    let pending = '';
    let timer = null;
    const flush = () => {
      timer = null;
      if (!pending) return;
      const add = pending;
      pending = '';
      setMessages((m) => {
        const copy = [...m];
        const last = copy[copy.length - 1];
        copy[copy.length - 1] = { ...last, text: last.text + add };
        return copy;
      });
    };

    const controller = new AbortController();
    abortRef.current = controller;
    let isNew = !conversationId;
    try {
      await api.sendPrompt(
        { prompt: text, model, conversationId },
        {
          onStart: (id, info) => {
            if (id && id !== conversationId) setConversationId(id);
            if (info?.blocked || info?.sources?.length) {
              setMessages((m) => {
                const copy = [...m];
                copy[copy.length - 1] = {
                  ...copy[copy.length - 1],
                  blocked: !!info.blocked,
                  sources: info.sources || [],
                };
                return copy;
              });
            }
          },
          onChunk: (chunk) => {
            pending += chunk;
            if (!timer) timer = setTimeout(flush, 50);
          },
        },
        controller.signal
      );
    } catch (err) {
      if (err.name !== 'AbortError') {
        setError(err.message);
        setMessages((m) => {
          const copy = [...m];
          const last = copy[copy.length - 1];
          if (last?.role === 'ai' && !last.text && !pending) copy[copy.length - 1] = { ...last, error: err.message };
          return copy;
        });
      }
    } finally {
      clearTimeout(timer);
      flush();
      setLoading(false);
      abortRef.current = null;
      // Refresh the sidebar (new chat title / ordering)
      if (isNew || conversations[0]?._id !== conversationId) loadConversations();
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) submit(e);
  }

  const activeTitle = conversations.find((c) => c._id === conversationId)?.title;

  return (
    <div className="chat-layout">
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <button className="new-chat" onClick={newChat} disabled={loading}>+ New chat</button>
        <div className="conv-list">
          {historyError && <div className="muted small">History unavailable: {historyError}</div>}
          {!historyError && conversations.length === 0 && <div className="muted small">No chats yet</div>}
          {conversations.map((c) => (
            <div
              key={c._id}
              className={`conv-item ${c._id === conversationId ? 'active' : ''}`}
              onClick={() => openConversation(c._id)}
              title={c.title}
            >
              <div className="conv-text">
                <span className="conv-title">{c.title}</span>
                <span className="conv-time">{timeAgo(c.updatedAt)}</span>
              </div>
              <button className="icon-btn" onClick={(e) => removeConversation(c._id, e)} aria-label="Delete chat">
                ✕
              </button>
            </div>
          ))}
        </div>
      </aside>
      {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}

      <main className="chat">
        <div className="chat-toolbar">
          <button className="ghost menu-btn" onClick={() => setSidebarOpen(true)} aria-label="Show chats">☰</button>
          <span className="chat-title">{activeTitle || 'New chat'}</span>
          <label>
            <select value={model} onChange={(e) => setModel(e.target.value)} disabled={loading}>
              {models.length + serverModels.length === 0 && <option value={model}>{model || 'No models found'}</option>}
              {serverModels.length > 0 ? (
                <>
                  <optgroup label={`${serverName} (faster)`}>
                    {serverModels.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </optgroup>
                  <optgroup label="This server (Ollama)">
                    {models.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </optgroup>
                </>
              ) : (
                models.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))
              )}
            </select>
          </label>
        </div>

        {health && (health.backendError || !health.ollama || !health.mongo || (health.aiServer && !health.aiServer.ok)) && (
          <div className="status-banner">
            <b>Setup problem:</b>
            <ul>
              {health.backendError && <li>{health.backendError}</li>}
              {!health.backendError && !health.ollama && <li>{health.ollamaError || 'Ollama is not reachable.'}</li>}
              {!health.backendError && health.aiServer && !health.aiServer.ok && (
                <li>
                  {health.aiServer.name} is not reachable{health.aiServer.error ? ` (${health.aiServer.error})` : ''}. Its models are
                  hidden until it’s back; models on this server still work.
                </li>
              )}
              {!health.backendError && !health.mongo && (
                <li>{health.mongoError || 'MongoDB is not connected.'} Chats will not be saved.</li>
              )}
            </ul>
          </div>
        )}

        {notice && <div className="policy-notice">{notice}</div>}

        <div className="messages" ref={listRef} onScroll={onScroll}>
          {messages.length === 0 && (
            <div className="empty">
              <h2>{assistantName ? `Hi, I'm ${assistantName}` : 'Ask anything'}</h2>
              <p>Runs on our own server — your questions never leave the company network. Your chats are saved and stay after a refresh.</p>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              <div className={`bubble ${m.error ? 'has-error' : ''} ${m.blocked ? 'blocked' : ''}`}>
                {m.blocked && <div className="blocked-label">⚠ Restricted by company policy</div>}
                {m.role === 'ai' ? (
                  m.text ? (
                    <>
                      <ReactMarkdown>{m.text}</ReactMarkdown>
                      {m.sources?.length > 0 && (
                        <div className="sources">
                          <span>📄 Source:</span>
                          {m.sources.map((src) => (
                            <span key={src.docId} className="source-chip">{src.title}</span>
                          ))}
                        </div>
                      )}
                      {!(loading && i === messages.length - 1) && (
                        <div className="msg-actions">
                          <button type="button" className="copy-btn" onClick={() => copyText(m.text, i)}>
                            {copied === i ? 'Copied ✓' : 'Copy'}
                          </button>
                        </div>
                      )}
                    </>
                  ) : m.error ? (
                    <span className="error-text">{m.error}</span>
                  ) : (
                    <span className="typing">
                      Thinking… {elapsed > 2 && `${elapsed}s`}
                      {elapsed > 20 && ' (the model is loading or the server is busy)'}
                    </span>
                  )
                ) : (
                  m.text
                )}
              </div>
            </div>
          ))}
        </div>

        {showScrollDown && messages.length > 0 && (
          <button type="button" className="ghost scroll-down" onClick={scrollToBottom}>↓ Latest</button>
        )}

        {error && <div className="alert">{error}</div>}

        <form className="composer" onSubmit={submit}>
          <textarea
            ref={inputRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type your prompt… (Enter to send, Shift+Enter for a new line)"
            rows={1}
          />
          {loading ? (
            <button type="button" className="danger" onClick={() => abortRef.current?.abort()}>Stop</button>
          ) : (
            <button type="submit" disabled={!prompt.trim()}>Send</button>
          )}
        </form>
      </main>
    </div>
  );
}
