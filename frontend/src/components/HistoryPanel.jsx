import {useState} from 'react';

function HistoryPanel({history, closeHistory, copyText}) {
    const [expandedHistoryId, setExpandedHistoryId] = useState(null);

    return (
        <aside className="history">
            <div className="history-header">
                <div>
                    <span>History</span>
                    <small>Recent queries</small>
                </div>
                <button className="secondary history-close-button" onClick={closeHistory} aria-label="Close history">×</button>
            </div>
            <div className="history-list">
                {history.length === 0 ? (
                    <div className="history-empty-state">Run a query to see history here.</div>
                ) : (
                    history.map((entry) => {
                        const isExpanded = expandedHistoryId === entry.id;
                        return (
                        <div key={entry.id} className={isExpanded ? 'history-item expanded' : 'history-item'}>
                            <span className={entry.success ? 'success-dot' : 'error-dot'} />
                            <span className="history-item-main">
                                <button
                                    type="button"
                                    className="history-item-summary"
                                    onClick={() => setExpandedHistoryId((current) => current === entry.id ? null : entry.id)}
                                >
                                    <span>
                                        <strong>{entry.database || 'default'}</strong>
                                        <small>{entry.durationMs} ms · {entry.rowCount} rows</small>
                                    </span>
                                    <span className="history-expand-icon" aria-hidden="true">{isExpanded ? '⌃' : '⌄'}</span>
                                </button>
                                <code>{entry.sql}</code>
                                {isExpanded && (
                                    <div className="history-query-preview">
                                        <button
                                            type="button"
                                            className="history-copy-button"
                                            onClick={() => copyText(entry.sql, 'Copied history query')}
                                            title="Copy query"
                                            aria-label="Copy query"
                                        >
                                            ⧉
                                        </button>
                                        <pre>{entry.sql}</pre>
                                    </div>
                                )}
                            </span>
                        </div>
                    );
                    })
                )}
            </div>
        </aside>
    );
}

export default HistoryPanel;
