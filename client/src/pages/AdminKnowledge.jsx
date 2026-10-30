import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

const fmtSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b > 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);
const TYPE_LABEL = { pdf: 'PDF', docx: 'Word', txt: 'Text file', text: 'Typed' };

export default function AdminKnowledge() {
  const [docs, setDocs] = useState([]);
  const [info, setInfo] = useState({ totalPassages: 0, embedModel: '' });
  const [settings, setSettings] = useState(null);
  const [kb, setKb] = useState({ kbEnabled: true, kbStrict: false, kbTopK: 3, kbNotFoundMessage: '' });
  const [kbSaved, setKbSaved] = useState('');
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [results, setResults] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newText, setNewText] = useState('');
  const [showAddText, setShowAddText] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState(null);
  const [busy, setBusy] = useState('');
  const fileRef = useRef(null);

  async function load() {
    try {
      const [list, s] = await Promise.all([api.kbList(), api.getSettings()]);
      setDocs(list.docs);
      setInfo(list);
      const { defaults, ...rest } = s;
      setSettings(rest);
      const k = {
        kbEnabled: rest.kbEnabled !== false,
        kbStrict: !!rest.kbStrict,
        kbTopK: rest.kbTopK || 3,
        kbNotFoundMessage: rest.kbNotFoundMessage || defaults?.kbNotFoundMessage || '',
      };
      setKb(k);
      setKbSaved(JSON.stringify(k));
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function saveKb() {
    setError('');
    try {
      // The settings endpoint saves everything, so send the full settings with our changes
      await api.saveSettings({ ...settings, ...kb });
      setKbSaved(JSON.stringify(kb));
    } catch (e) {
      setError(e.message);
    }
  }

  async function uploadFiles(fileList) {
    const files = [...fileList].filter(Boolean);
    if (!files.length) return;
    setError('');
    setResults([]);
    setUploading(true);
    try {
      const { results } = await api.kbUpload(files);
      setResults(results);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function addText(e) {
    e.preventDefault();
    setError('');
    setBusy('add');
    try {
      await api.kbAddText(newTitle, newText);
      setNewTitle('');
      setNewText('');
      setShowAddText(false);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function toggle(doc) {
    try {
      await api.kbUpdate(doc._id, { enabled: !doc.enabled });
      setDocs((d) => d.map((x) => (x._id === doc._id ? { ...x, enabled: !doc.enabled } : x)));
    } catch (e) {
      setError(e.message);
    }
  }

  async function remove(doc) {
    if (!confirm(`Delete "${doc.title}"? The AI will no longer use it.`)) return;
    try {
      await api.kbDelete(doc._id);
      await load();
    } catch (e) {
      setError(e.message);
    }
  }

  async function openDoc(doc) {
    try {
      setViewing({ ...(await api.kbGet(doc._id)), editing: false });
    } catch (e) {
      setError(e.message);
    }
  }

  async function saveDoc() {
    setBusy('save');
    try {
      await api.kbUpdate(viewing._id, { title: viewing.title, text: viewing.text });
      setViewing(null);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }

  async function search(e) {
    e.preventDefault();
    if (!query.trim()) return;
    try {
      setHits((await api.kbSearch(query)).passages);
    } catch (err) {
      setError(err.message);
    }
  }

  async function reindex() {
    setBusy('reindex');
    try {
      const r = await api.kbReindex();
      if (!r.meaningSearch) setError(`Meaning-based search is unavailable: run "ollama pull ${info.embedModel || 'all-minilm'}" on the server, then try again.`);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }

  const kbDirty = JSON.stringify(kb) !== kbSaved;
  const notEmbedded = info.embedModel && docs.some((d) => !d.embedded);

  return (
    <main className="policies">
      <div className="policies-head">
        <h2>Policy documents</h2>
        <span className="muted small">
          {docs.length} documents · {info.totalPassages} passages
        </span>
      </div>

      {error && (
        <div className="alert" onClick={() => setError('')} title="Click to dismiss">
          {error}
        </div>
      )}

      <section className="panel">
        <h4>How the assistant uses them</h4>
        <div className="kb-settings">
          <label className="toggle big">
            <input type="checkbox" checked={kb.kbEnabled} onChange={(e) => setKb({ ...kb, kbEnabled: e.target.checked })} />
            Answer staff questions from these documents
          </label>
          <label className="toggle big">
            <input type="checkbox" checked={kb.kbStrict} onChange={(e) => setKb({ ...kb, kbStrict: e.target.checked })} />
            Only answer from the documents
            <small className="muted"> (questions not covered get the reply below, nothing else is answered)</small>
          </label>
          <label className="toggle big">
            Passages given to the AI per question
            <select value={kb.kbTopK} onChange={(e) => setKb({ ...kb, kbTopK: Number(e.target.value) })}>
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>{n}{n === 3 ? ' (recommended)' : ''}</option>
              ))}
            </select>
          </label>
          <div className="field">
            <span>Reply when the answer isn’t in the documents <small>(used when “only answer from the documents” is on)</small></span>
            <input value={kb.kbNotFoundMessage} onChange={(e) => setKb({ ...kb, kbNotFoundMessage: e.target.value })} />
          </div>
          <div className="row">
            <button onClick={saveKb} disabled={!kbDirty}>Save</button>
            {!kbDirty && kbSaved && <span className="muted small">Saved</span>}
          </div>
        </div>
      </section>

      <section className="panel">
        <h4>Add documents</h4>
        <div
          className={`dropzone ${dragOver ? 'over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            uploadFiles(e.dataTransfer.files);
          }}
          onClick={() => !uploading && fileRef.current?.click()}
        >
          <input
            ref={fileRef}
            type="file"
            multiple
            accept=".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
            hidden
            onChange={(e) => uploadFiles(e.target.files)}
          />
          {uploading ? (
            <b>Reading and indexing… this can take a minute for long documents</b>
          ) : (
            <>
              <b>Drop PDF, Word (.docx) or .txt files here, or click to choose</b>
              <span className="muted small">Up to 10 files at a time, 20 MB each. Scanned PDFs (photos of pages) can’t be read.</span>
            </>
          )}
        </div>

        {results.length > 0 && (
          <ul className="upload-results">
            {results.map((r, i) => (
              <li key={i} className={r.ok ? 'ok-text' : 'error-text'}>
                {r.ok ? '✓' : '✕'} {r.file}: {r.ok ? `added as “${r.title}” (${r.passages} passages)` : r.message}
              </li>
            ))}
          </ul>
        )}

        <div style={{ marginTop: 12 }}>
          {!showAddText ? (
            <button className="ghost" onClick={() => setShowAddText(true)}>+ Type or paste a policy instead</button>
          ) : (
            <form onSubmit={addText} className="add-text">
              <input placeholder="Policy title, e.g. Leave Policy" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} required />
              <textarea
                rows={10}
                placeholder={'Paste the policy text here.\n\nTip: put each section heading on its own line, e.g.\n\nCasual Leave\nEvery employee gets 12 days of casual leave per year…'}
                value={newText}
                onChange={(e) => setNewText(e.target.value)}
                required
              />
              <div className="row">
                <button type="submit" disabled={busy === 'add'}>{busy === 'add' ? 'Saving…' : 'Add policy'}</button>
                <button type="button" className="ghost" onClick={() => setShowAddText(false)}>Cancel</button>
              </div>
            </form>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h4 style={{ margin: 0 }}>Documents</h4>
          {notEmbedded && (
            <button className="ghost" onClick={reindex} disabled={busy === 'reindex'} title="Builds meaning-based search for all documents">
              {busy === 'reindex' ? 'Processing…' : 'Enable meaning search for all'}
            </button>
          )}
        </div>
        {docs.length === 0 ? (
          <p className="muted">No documents yet. Upload your leave, travel, IT or HR policies above.</p>
        ) : (
          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table>
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Type</th>
                  <th>Passages</th>
                  <th>Updated</th>
                  <th>In use</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d._id} className={d.enabled ? '' : 'row-off'}>
                    <td>
                      <button className="link-btn" onClick={() => openDoc(d)}>{d.title}</button>
                      {d.filename && <div className="muted small" style={{ padding: 0 }}>{d.filename}{d.size ? ` · ${fmtSize(d.size)}` : ''}</div>}
                    </td>
                    <td className="nowrap">{TYPE_LABEL[d.type] || d.type}</td>
                    <td className="nowrap">
                      {d.chunkCount}
                      {info.embedModel && !d.embedded && <span className="muted small" title="Keyword search only"> · keywords</span>}
                    </td>
                    <td className="nowrap">{new Date(d.updatedAt).toLocaleDateString()}</td>
                    <td>
                      <label className="toggle">
                        <input type="checkbox" checked={d.enabled} onChange={() => toggle(d)} /> {d.enabled ? 'On' : 'Off'}
                      </label>
                    </td>
                    <td className="nowrap">
                      <button className="ghost" onClick={() => openDoc(d)}>View</button>{' '}
                      <button className="ghost" onClick={() => remove(d)} aria-label="Delete">✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <h4>Test a question</h4>
        <p className="muted small">Shows which passages the AI would receive. Nothing is sent to the AI.</p>
        <form className="row" onSubmit={search}>
          <input style={{ flex: 1, minWidth: 200 }} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. How many sick leaves do I get?" />
          <button type="submit" disabled={!query.trim()}>Test</button>
        </form>
        {hits && (
          <div className="hits">
            {hits.length === 0 ? (
              <div className="test-result fail">No passage matched. The AI answers without policy documents{kb.kbStrict ? ' — in “only answer from the documents” mode the user gets the not-found reply' : ''}.</div>
            ) : (
              hits.map((h, i) => (
                <div key={i} className="hit">
                  <div className="hit-head">
                    <b>{i + 1}. {h.docTitle}</b>
                    {h.heading && <span className="muted"> — {h.heading}</span>}
                    <span className="muted small hit-score">
                      keyword {h.keywordScore}
                      {h.meaningScore !== null ? ` · meaning ${h.meaningScore}` : ''}
                    </span>
                  </div>
                  <div className="hit-text">{h.text}</div>
                </div>
              ))
            )}
          </div>
        )}
      </section>

      {viewing && (
        <div className="modal-backdrop" onClick={() => setViewing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              {viewing.editing ? (
                <input style={{ flex: 1, marginRight: 8 }} value={viewing.title} onChange={(e) => setViewing({ ...viewing, title: e.target.value })} />
              ) : (
                <h3>{viewing.title}</h3>
              )}
              <button className="ghost" onClick={() => setViewing(null)}>✕</button>
            </div>
            <p className="muted small">
              {TYPE_LABEL[viewing.type]} · {viewing.chunkCount} passages · text the AI can read
              {viewing.type === 'pdf' && ' (check that tables and numbers came through correctly)'}
            </p>
            {viewing.editing ? (
              <textarea className="doc-edit" value={viewing.text} onChange={(e) => setViewing({ ...viewing, text: e.target.value })} />
            ) : (
              <pre className="block doc-text">{viewing.text}</pre>
            )}
            <div className="modal-foot" style={{ gap: 8 }}>
              {viewing.editing ? (
                <button onClick={saveDoc} disabled={busy === 'save'}>{busy === 'save' ? 'Saving…' : 'Save changes'}</button>
              ) : (
                <button className="ghost" onClick={() => setViewing({ ...viewing, editing: true })}>Edit text</button>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
