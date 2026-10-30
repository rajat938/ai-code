import ReactMarkdown from 'react-markdown';

export default function LogModal({ log, onClose, onDelete, onFilter }) {
  if (!log) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Prompt details</h3>
          <button className="ghost" onClick={onClose}>✕</button>
        </div>
        <div className="meta">
          <span><b>Time:</b> {new Date(log.createdAt).toLocaleString()}</span>
          <span><b>Model:</b> {log.model}</span>
          <span><b>Status:</b> <span className={`badge ${log.status}`}>{log.status}</span></span>
          {log.blockedRule && <span><b>Blocked by:</b> {log.blockedRule}</span>}
          <span><b>Duration:</b> {(log.durationMs / 1000).toFixed(2)}s</span>
          <span><b>Tokens:</b> {log.promptTokens} in / {log.responseTokens} out</span>
          <span><b>IP:</b> {log.ip || '—'}</span>
          {log.clientId && (
            <span><b>User:</b> <span className="mono">{log.clientId}</span></span>
          )}
        </div>
        {(log.clientId || log.conversationId) && (
          <div className="row" style={{ marginBottom: 8 }}>
            {log.conversationId && (
              <button className="ghost" onClick={() => onFilter('conversationId', String(log.conversationId))}>
                Show whole chat
              </button>
            )}
            {log.clientId && (
              <button className="ghost" onClick={() => onFilter('clientId', log.clientId)}>
                All prompts from this user
              </button>
            )}
          </div>
        )}
        <h4>Prompt</h4>
        <pre className="block">{log.prompt}</pre>
        <h4>Output</h4>
        <div className="block md">
          {log.response ? <ReactMarkdown>{log.response}</ReactMarkdown> : <i>No output</i>}
        </div>
        {log.error && (
          <>
            <h4>Error</h4>
            <pre className="block error">{log.error}</pre>
          </>
        )}
        <div className="modal-foot">
          <button className="danger" onClick={() => onDelete(log._id)}>Delete</button>
        </div>
      </div>
    </div>
  );
}
