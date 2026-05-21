function QueryToolbar({
    queryTabs,
    activeTabId,
    activeTab,
    setActiveTabId,
    closeQueryTab,
    addQueryTab,
    updateActiveTab,
    runQuery,
    isRunning,
    killQuery,
    explainQuery,
    formatQuery,
    toggleHistory,
    saveQuery,
}) {
    return (
        <header className="topbar">
            <div className="query-tabs">
                {queryTabs.map((tab) => (
                    <button
                        key={tab.id}
                        className={tab.id === activeTabId ? 'query-tab active' : 'query-tab'}
                        onClick={() => setActiveTabId(tab.id)}
                    >
                        <span>{tab.title}</span>
                        {queryTabs.length > 1 && (
                            <span
                                className="tab-close"
                                onClick={(event) => {
                                    event.stopPropagation();
                                    closeQueryTab(tab.id);
                                }}
                            >
                                ×
                            </span>
                        )}
                    </button>
                ))}
                <button className="query-tab add" onClick={addQueryTab}>+</button>
            </div>
            <div className="toolbar-actions">
                <select
                    className="query-limit-select"
                    value={activeTab?.limit || 100}
                    onChange={(event) => updateActiveTab({limit: Number(event.target.value)})}
                    title="Default limit used when SQL has no LIMIT"
                >
                    <option value="50">50 rows</option>
                    <option value="100">100 rows</option>
                    <option value="250">250 rows</option>
                    <option value="500">500 rows</option>
                    <option value="1000">1000 rows</option>
                    <option value="5000">5000 rows</option>
                </select>
                <button className="icon-button run-button" onClick={runQuery} disabled={isRunning} title="Run query (Cmd/Ctrl + Enter)" data-tooltip="Run query">
                    ▶
                </button>
                <button className="icon-button kill-button" onClick={killQuery} title="Kill running query" data-tooltip="Kill query">
                    ■
                </button>
                <button className="icon-button secondary" onClick={explainQuery} disabled={isRunning} title="Explain query" data-tooltip="Explain query">
                    ?
                </button>
                <button className="icon-button secondary" onClick={formatQuery} title="Format SQL" data-tooltip="Format SQL">
                    {'{}'}
                </button>
                <button className="icon-button secondary" onClick={toggleHistory} title="Show recent queries" data-tooltip="History">
                    ◷
                </button>
                <button className="icon-button secondary" onClick={saveQuery} title="Save query" data-tooltip="Save query">
                    ⇩
                </button>
            </div>
        </header>
    );
}

export default QueryToolbar;
