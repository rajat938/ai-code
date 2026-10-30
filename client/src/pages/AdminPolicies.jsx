import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';

const emptyRule = () => ({ name: '', keywords: [], pattern: '', message: '', enabled: true });

// The settings as they are sent to the server
function toPayload(s) {
  return {
    assistantName: s.assistantName,
    userNotice: s.userNotice,
    systemPrompt: s.systemPrompt,
    defaultBlockMessage: s.defaultBlockMessage,
    rules: s.rules.map((r) => ({
      ...r,
      keywords: Array.isArray(r.keywords)
        ? r.keywords
        : String(r.keywords || '')
            .split(',')
            .map((k) => k.trim())
            .filter(Boolean),
    })),
  };
}

export default function AdminPolicies() {
  const [settings, setSettings] = useState(null);
  const [defaults, setDefaults] = useState(null);
  const [savedJson, setSavedJson] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [testText, setTestText] = useState('');
  const [testResult, setTestResult] = useState(null);
  const [servers, setServers] = useState(null);

  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        const { defaults: d, ...rest } = s;
        // Keywords are edited as comma-separated text
        rest.rules = (rest.rules || []).map((r) => ({ ...r, keywords: (r.keywords || []).join(', ') }));
        setDefaults(d);
        setSettings(rest);
        setSavedJson(JSON.stringify(toPayload(rest)));
      })
      .catch((e) => setError(e.message));
  }, []);

  const loadServers = () => api.aiServers().then(setServers).catch(() => setServers(null));
  useEffect(() => {
    loadServers();
  }, []);

  const dirty = useMemo(() => settings && JSON.stringify(toPayload(settings)) !== savedJson, [settings, savedJson]);

  // Warn before leaving with unsaved changes
  useEffect(() => {
    const h = (e) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const set = (key, value) => setSettings((s) => ({ ...s, [key]: value }));
  const setRule = (i, key, value) =>
    setSettings((s) => ({ ...s, rules: s.rules.map((r, j) => (j === i ? { ...r, [key]: value } : r)) }));
  const addRule = () => setSettings((s) => ({ ...s, rules: [...s.rules, emptyRule()] }));
  const removeRule = (i) => {
    if (!confirm(`Delete the rule "${settings.rules[i].name || 'untitled'}"?`)) return;
    setSettings((s) => ({ ...s, rules: s.rules.filter((_, j) => j !== i) }));
  };

  async function save() {
    setError('');
    setSaving(true);
    try {
      const payload = toPayload(settings);
      const saved = await api.saveSettings(payload);
      saved.rules = (saved.rules || []).map((r) => ({ ...r, keywords: (r.keywords || []).join(', ') }));
      setSettings(saved);
      setSavedJson(JSON.stringify(toPayload(saved)));
      setSavedAt(new Date());
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function runTest(e) {
    e?.preventDefault();
    if (!testText.trim()) return;
    setError('');
    try {
      setTestResult(await api.testPrompt(testText, toPayload(settings)));
    } catch (err) {
      setError(err.message);
    }
  }

  function resetToDefaults() {
    if (!defaults || !confirm('Replace all fields with the example defaults? (Not saved until you click Save.)')) return;
    setSettings((s) => ({
      ...s,
      ...defaults,
      rules: defaults.rules.map((r) => ({ ...r, keywords: r.keywords.join(', ') })),
    }));
  }

  if (!settings) {
    return <main className="policies">{error ? <div className="alert">{error}</div> : <p>Loading…</p>}</main>;
  }

  return (
    <main className="policies">
      <div className="policies-head">
        <h2>Rules &amp; restrictions</h2>
        <div className="row">
          {savedAt && !dirty && <span className="saved-msg">Saved ✓</span>}
          {dirty && <span className="muted">Unsaved changes</span>}
          <button className="ghost" onClick={resetToDefaults}>Load examples</button>
          <button onClick={save} disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>

      {error && <div className="alert">{error}</div>}

      <section className="panel">
        <h4>Assistant</h4>
        <div className="field">
          <span>Name</span>
          <input value={settings.assistantName} onChange={(e) => set('assistantName', e.target.value)} maxLength={80} />
        </div>
        <div className="field" style={{ marginTop: 12 }}>
          <span>Notice shown to staff <small>— appears above the chat</small></span>
          <textarea rows={2} value={settings.userNotice} onChange={(e) => set('userNotice', e.target.value)} maxLength={1000} />
        </div>
      </section>

      <section className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h4 style={{ margin: 0 }}>AI servers</h4>
          <button className="ghost" onClick={loadServers}>Refresh</button>
        </div>
        <p className="muted small">Everything runs inside your network. Set up in <code>server/.env</code>.</p>
        {!servers ? (
          <p className="muted small">Loading…</p>
        ) : (
          <div className="server-list">
            <div className="server-row">
              <span className={`dot ${servers.ollama.ok ? 'ok' : 'bad'}`} />
              <b>This server (Ollama)</b>
              <span className="muted small">{servers.ollama.ok ? servers.ollama.models.join(', ') || 'no models' : servers.ollama.error}</span>
            </div>
            {servers.aiServer ? (
              <div className="server-row">
                <span className={`dot ${servers.aiServer.ok ? 'ok' : 'bad'}`} />
                <b>{servers.aiServer.name}</b>
                <span className="muted small">
                  {servers.aiServer.ok ? servers.aiServer.models.join(', ') : servers.aiServer.error} · {servers.aiServer.url}
                </span>
              </div>
            ) : (
              <p className="muted small" style={{ margin: 0 }}>
                No GPU AI server set up. To add one on your network, set <code>LOCAL_AI_SERVER_URL</code> in{' '}
                <code>server/.env</code> (see README).
              </p>
            )}
            <span className="muted small">Default model: {servers.defaultModel}</span>
          </div>
        )}
      </section>

      <section className="panel">
        <h4>Policies the AI must follow</h4>
        <div className="field">
          <span>
            Instructions <small>— sent to the model with every question. Keep it short (under ~300 words): longer text makes every answer slower on CPU.</small>
          </span>
          <textarea rows={10} value={settings.systemPrompt} onChange={(e) => set('systemPrompt', e.target.value)} maxLength={8000} />
          <small className="muted">{settings.systemPrompt.trim().split(/\s+/).filter(Boolean).length} words</small>
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>
          Small models follow these instructions most of the time, not always. For topics that must never be answered, add a
          restricted topic below. Those are blocked before the AI sees them.
        </p>
      </section>

      <section className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h4 style={{ margin: 0 }}>Restricted topics</h4>
          <button className="ghost" onClick={addRule}>+ Add topic</button>
        </div>
        <p className="muted small">
          A question containing any keyword is blocked: the user gets the reply below and the prompt is marked “blocked” in the
          logs. Keywords match whole words, ignore upper/lower case, and <code>*</code> is a wildcard (<code>salar*</code> matches
          salary, salaries).
        </p>
        <div className="field" style={{ marginBottom: 12 }}>
          <span>Default reply when blocked</span>
          <textarea rows={2} value={settings.defaultBlockMessage} onChange={(e) => set('defaultBlockMessage', e.target.value)} />
        </div>

        <div style={{ display: 'grid', gap: 10 }}>
          {settings.rules.length === 0 && <i className="muted">No restricted topics.</i>}
          {settings.rules.map((r, i) => (
            <div key={i} className={`rule ${r.enabled ? '' : 'off'}`}>
              <div className="rule-top">
                <input type="text" placeholder="Topic name, e.g. Salary & compensation" value={r.name} onChange={(e) => setRule(i, 'name', e.target.value)} />
                <label className="toggle">
                  <input type="checkbox" checked={r.enabled} onChange={(e) => setRule(i, 'enabled', e.target.checked)} /> On
                </label>
                <button className="ghost" onClick={() => removeRule(i)} aria-label="Delete rule">✕</button>
              </div>
              <div className="field">
                <span>Keywords <small>— comma separated</small></span>
                <textarea rows={2} value={r.keywords} onChange={(e) => setRule(i, 'keywords', e.target.value)} placeholder="salary, payroll, pay slip, ctc" />
              </div>
              <div className="field">
                <span>Reply to user <small>— leave empty to use the default reply</small></span>
                <input value={r.message} onChange={(e) => setRule(i, 'message', e.target.value)} />
              </div>
              <details>
                <summary className="muted small">Advanced: regular expression</summary>
                <input style={{ width: '100%', marginTop: 6 }} className="mono" value={r.pattern} onChange={(e) => setRule(i, 'pattern', e.target.value)} placeholder="e.g. \b\d{4}\s?\d{4}\s?\d{4}\b  (Aadhaar-like numbers)" />
              </details>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <h4>Test a question</h4>
        <p className="muted small">Checks the settings on this page, including unsaved changes. Nothing is sent to the AI.</p>
        <form className="row" onSubmit={runTest}>
          <input style={{ flex: 1, minWidth: 200 }} value={testText} onChange={(e) => setTestText(e.target.value)} placeholder="e.g. What is the CEO's salary?" />
          <button type="submit" disabled={!testText.trim()}>Test</button>
        </form>
        {testResult && (
          <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
            {testResult.blocked ? (
              <div className="test-result fail">
                <b>Blocked</b> by “{testResult.rule}” (matched “{testResult.matched}”). Reply: {testResult.message}
              </div>
            ) : (
              <div className="test-result pass">
                <b>Allowed.</b> It goes to the AI, which still follows the policy instructions above.
              </div>
            )}
            <details className="sys-preview">
              <summary>Show the full instructions sent to the AI</summary>
              <pre className="block">{testResult.systemPrompt}</pre>
            </details>
          </div>
        )}
      </section>

      {settings.updatedAt && (
        <p className="muted small">
          Last saved {new Date(settings.updatedAt).toLocaleString()}
          {settings.updatedBy ? ` by ${settings.updatedBy}` : ''}
        </p>
      )}
    </main>
  );
}
