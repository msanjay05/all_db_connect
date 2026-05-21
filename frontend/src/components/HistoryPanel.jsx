function HistoryPanel({history, closeHistory, updateActiveTab}) {
    return (
        <aside className="history">
            <div className="panel-title">
                <span>Recent Queries</span>
                <button className="secondary small" onClick={closeHistory}>Close</button>
            </div>
            <div className="history-list">
                {history.slice(0, 10).map((entry) => (
                    <button key={entry.id} className="history-item" onClick={() => updateActiveTab({sql: entry.sql})}>
                        <span className={entry.success ? 'success-dot' : 'error-dot'} />
                        <strong>{entry.database || 'mysql'}</strong>
                        <small>{entry.durationMs} ms | {entry.rowCount} rows</small>
                        <code>{entry.sql}</code>
                    </button>
                ))}
            </div>
        </aside>
    );
}

export default HistoryPanel;
