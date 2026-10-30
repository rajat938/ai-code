import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, tokenStore } from '../api.js';
import LogModal from '../components/LogModal.jsx';

const truncate = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');

export default function AdminDashboard() {
  const navigate = useNavigate();
  const [stats, setStats] = useState(null);
  const [health, setHealth] = useState(null);
  const [data, setData] = useState({ items: [], total: 0, pages: 1 });
  const [filters, setFilters] = useState({ q: '', status: '', model: '', from: '', to: '', clientId: '', conversationId: '' });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const activeFilters = Object.fromEntries(Object.entries(filters).filter(([, v]) => v));

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [s, l, h] = await Promise.all([
        api.stats(),
        api.logs({ ...activeFilters, page, limit: 20 }),
        api.health().catch(() => null),
      ]);
      setStats(s);
      setData(l);
      setHealth(h);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, JSON.stringify(activeFilters)]);

  useEffect(() => {
    load();
  }, [load]);

  // Auto-refresh every 15 seconds so new prompts show up
  useEffect(() => {
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  function setFilter(key, value) {
    setPage(1);
    setFilters((f) => ({ ...f, [key]: value }));
  }

  async function remove(id) {
    if (!confirm('Delete this log entry?')) return;
    await api.deleteLog(id);
    setSelected(null);
    load();
  }

  function logout() {
    tokenStore.clear();
    navigate('/admin/login');
  }

  const maxDaily = Math.max(1, ...(stats?.daily || []).map((d) => d.count));

  return (
    <main className="admin">
      <div className="admin-head">
        <h2>Admin dashboard</h2>
        <div className="row">
          {health && (
            <span className="health">
              <span className={`dot ${health.ollama ? 'ok' : 'bad'}`} /> Ollama
              <span className={`dot ${health.mongo ? 'ok' : 'bad'}`} /> MongoDB
            </span>
          )}
          <button className="ghost" onClick={load} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
          <button className="ghost" onClick={() => api.exportCsv(activeFilters)}>Export CSV</button>
          <button className="ghost" onClick={logout}>Logout</button>
        </div>
      </div>

      {error && <div className="alert">{error}</div>}

      {stats && (
        <>
          <section className="stats">
            <div className="stat"><span>Total prompts</span><b>{stats.total}</b></div>
            <div className="stat"><span>Today</span><b>{stats.today}</b></div>
            <div className="stat"><span>Errors</span><b>{stats.errors}</b></div>
            <div className="stat clickable-stat" onClick={() => setFilter('status', 'blocked')} title="Show blocked prompts">
              <span>Blocked by policy</span><b>{stats.blocked ?? 0}</b>
            </div>
            <div className="stat"><span>Users</span><b>{stats.users ?? 0}</b></div>
            <div className="stat"><span>Chats</span><b>{stats.conversations ?? 0}</b></div>
            <div className="stat"><span>Avg response time</span><b>{(stats.avgDurationMs / 1000).toFixed(1)}s</b></div>
          </section>

          <section className="panels">
            <div className="panel">
              <h4>Prompts per day (last 14 days)</h4>
              <div className="bars">
                {stats.daily.length === 0 && <i>No data yet</i>}
                {stats.daily.map((d) => (
                  <div key={d.date} className="bar-col" title={`${d.date}: ${d.count}`}>
                    <div className="bar" style={{ height: `${(d.count / maxDaily) * 100}%` }} />
                    <small>{d.date.slice(5)}</small>
                  </div>
                ))}
              </div>
            </div>
            <div className="panel">
              <h4>By model</h4>
              {stats.byModel.length === 0 && <i>No data yet</i>}
              <ul className="model-list">
                {stats.byModel.map((m) => (
                  <li key={m.model}>
                    <span>{m.model}</span>
                    <b>{m.count}</b>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        </>
      )}

      <section className="filters">
        <input placeholder="Search prompt or output…" value={filters.q} onChange={(e) => setFilter('q', e.target.value)} />
        <select value={filters.status} onChange={(e) => setFilter('status', e.target.value)}>
          <option value="">All statuses</option>
          <option value="success">Success</option>
          <option value="error">Error</option>
          <option value="pending">Pending</option>
          <option value="blocked">Blocked by policy</option>
        </select>
        <select value={filters.model} onChange={(e) => setFilter('model', e.target.value)}>
          <option value="">All models</option>
          {(stats?.byModel || []).map((m) => (
            <option key={m.model} value={m.model}>{m.model}</option>
          ))}
        </select>
        <input type="date" value={filters.from} onChange={(e) => setFilter('from', e.target.value)} />
        <input type="date" value={filters.to} onChange={(e) => setFilter('to', e.target.value)} />
      </section>

      {(filters.clientId || filters.conversationId) && (
        <div className="row" style={{ marginBottom: 12 }}>
          {filters.clientId && (
            <span className="chip">
              User <span className="mono">{filters.clientId.slice(0, 8)}</span>
              <button className="link-btn" onClick={() => setFilter('clientId', '')}>✕</button>
            </span>
          )}
          {filters.conversationId && (
            <span className="chip">
              Chat <span className="mono">{filters.conversationId.slice(-6)}</span>
              <button className="link-btn" onClick={() => setFilter('conversationId', '')}>✕</button>
            </span>
          )}
        </div>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Prompt</th>
              <th>Output</th>
              <th>User</th>
              <th>Model</th>
              <th>Status</th>
              <th>Time taken</th>
            </tr>
          </thead>
          <tbody>
            {data.items.length === 0 && (
              <tr><td colSpan={7} className="center"><i>No prompts found</i></td></tr>
            )}
            {data.items.map((l) => (
              <tr key={l._id} onClick={() => setSelected(l)} className="clickable">
                <td className="nowrap">{new Date(l.createdAt).toLocaleString()}</td>
                <td>{truncate(l.prompt, 80)}</td>
                <td className="muted">{truncate(l.response || l.error, 100)}</td>
                <td className="nowrap">
                  {l.clientId ? (
                    <button
                      className="link-btn mono"
                      title="Show all prompts from this user"
                      onClick={(e) => {
                        e.stopPropagation();
                        setFilter('clientId', l.clientId);
                      }}
                    >
                      {l.clientId.slice(0, 8)}
                    </button>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="nowrap">{l.model}</td>
                <td>
                  <span className={`badge ${l.status}`} title={l.blockedRule || ''}>{l.status}</span>
                  {l.blockedRule && <div className="muted small" style={{ padding: 0 }}>{l.blockedRule}</div>}
                </td>
                <td className="nowrap">{(l.durationMs / 1000).toFixed(1)}s</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="pager">
        <button className="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>← Prev</button>
        <span>Page {data.page || page} of {data.pages} · {data.total} results</span>
        <button className="ghost" disabled={page >= data.pages} onClick={() => setPage((p) => p + 1)}>Next →</button>
      </div>

      <LogModal
        log={selected}
        onClose={() => setSelected(null)}
        onDelete={remove}
        onFilter={(key, value) => {
          setSelected(null);
          setFilter(key, value);
        }}
      />
    </main>
  );
}
