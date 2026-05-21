import CompactSelect from './CompactSelect';
import {
    columnIconClass,
    columnIconLabel,
    formatColumnMeta,
    formatRowCount,
} from '../utils/results';

function Sidebar({
    selectedConnectionId,
    connectionOptions,
    handleConnectionChange,
    selectedProfile,
    editProfile,
    disconnectProfile,
    deleteProfile,
    profiles,
    selectProfile,
    newProfile,
    showConnectionForm,
    closeProfileForm,
    profileForm,
    updateProfileField,
    testConnection,
    saveProfile,
    connectionTestStatus,
    databaseOptions,
    selectedDatabase,
    databases,
    selectDatabase,
    loadDatabases,
    setDefaultDatabase,
    filteredSchemaTables,
    tableFilter,
    setTableFilter,
    loadSchema,
    insertTableReference,
}) {
    return (
        <aside className="sidebar">
            <section className="sidebar-connection-card">
                <div className="active-connection-row">
                    <div className="active-connection-select">
                        <CompactSelect
                            className="connection-select"
                            value={selectedConnectionId}
                            options={connectionOptions}
                            placeholder="Select connection"
                            onChange={handleConnectionChange}
                        />
                        {selectedProfile && (
                            <div className="active-connection-meta" title={selectedProfile.host}>
                                <span className="connection-status-icon connected" aria-hidden="true" />
                                <small>{selectedProfile.host}</small>
                            </div>
                        )}
                    </div>
                    <button className="secondary connection-action-button" onClick={editProfile} disabled={!selectedConnectionId} title="Edit connection" aria-label="Edit connection">
                        <svg className="connection-action-svg" viewBox="0 0 16 16" aria-hidden="true">
                            <path d="M3 11.5V13h1.5L12 5.5 10.5 4 3 11.5Z" />
                            <path d="m9.8 4.7 1.5 1.5" />
                        </svg>
                    </button>
                    <button className="secondary connection-action-button" onClick={disconnectProfile} disabled={!selectedConnectionId} title="Disable connection" aria-label="Disable connection">
                        <svg className="connection-action-svg" viewBox="0 0 16 16" aria-hidden="true">
                            <path d="M4 4l8 8M12 4l-8 8" />
                        </svg>
                    </button>
                    <button className="danger connection-action-button" onClick={deleteProfile} disabled={!selectedConnectionId} title="Delete connection" aria-label="Delete connection">
                        <svg className="connection-action-svg" viewBox="0 0 16 16" aria-hidden="true">
                            <path d="M5.5 5.5v6M8 5.5v6M10.5 5.5v6" />
                            <path d="M3.5 4h9M6.5 2.5h3L10 4H6l.5-1.5Z" />
                            <path d="M4.5 4.5 5 13h6l.5-8.5" />
                        </svg>
                    </button>
                </div>
                <div className="connection-chips">
                    {profiles.slice(0, 4).map((profile) => {
                        const isActive = profile.id === selectedConnectionId;
                        return (
                            <button
                                key={profile.id}
                                className={isActive ? 'connection-chip active' : 'connection-chip'}
                                onClick={() => selectProfile(profile)}
                                title={`${profile.host} (${isActive ? 'connected' : 'disconnected'})`}
                            >
                                <span className={isActive ? 'connection-status-icon connected' : 'connection-status-icon disconnected'} aria-hidden="true" />
                                {profile.name}
                            </button>
                        );
                    })}
                </div>
                <div className="connection-picker">
                    <button className="new-connection-button" onClick={newProfile}>+ New Connection</button>
                </div>
            </section>

            {showConnectionForm && (
                <section className="panel form-panel">
                    <div className="panel-title">
                        <span>Connection Details</span>
                        <button className="secondary" onClick={closeProfileForm}>Cancel</button>
                    </div>
                    <label>Name<input value={profileForm.name} onChange={(event) => updateProfileField('name', event.target.value)}/></label>
                    <label>Host<input value={profileForm.host} onChange={(event) => updateProfileField('host', event.target.value)}/></label>
                    <label>Port<input type="number" value={profileForm.port} onChange={(event) => updateProfileField('port', event.target.value)}/></label>
                    <label>User<input value={profileForm.username} onChange={(event) => updateProfileField('username', event.target.value)}/></label>
                    <label>Password<input type="password" value={profileForm.password} onChange={(event) => updateProfileField('password', event.target.value)}/></label>
                    <label className="checkbox-label">
                        <input
                            type="checkbox"
                            checked={Boolean(profileForm.readOnly)}
                            onChange={(event) => updateProfileField('readOnly', event.target.checked)}
                        />
                        Read only (DQL queries only)
                    </label>
                    {profileForm.id && <div className="hint">Leave password blank to keep the saved password.</div>}
                    <div className="button-row two">
                        <button onClick={testConnection}>Test</button>
                        <button onClick={saveProfile}>Save</button>
                    </div>
                    {connectionTestStatus && (
                        <div className="connection-test-status">{connectionTestStatus}</div>
                    )}
                </section>
            )}

            {selectedConnectionId && (
                <section className="database-panel">
                    <div className="sidebar-section-title">
                        <span>Database</span>
                        <button className="sidebar-refresh" onClick={() => loadDatabases()} disabled={!selectedConnectionId} title="Refresh databases">↻</button>
                    </div>
                    <CompactSelect
                        className="database-select"
                        value={selectedDatabase}
                        options={databaseOptions}
                        placeholder="Select database"
                        disabled={!selectedConnectionId || databases.length === 0}
                        onChange={selectDatabase}
                    />
                    {selectedConnectionId && databases.length === 0 && (
                        <div className="hint">No databases loaded yet. Use Refresh after selecting a connection.</div>
                    )}
                    {selectedDatabase && (
                        <button className="secondary full-width" onClick={() => setDefaultDatabase()}>
                            {profiles.find((profile) => profile.id === selectedConnectionId)?.database === selectedDatabase ? 'Default database' : 'Mark as default'}
                        </button>
                    )}
                </section>
            )}

            {selectedDatabase && (
                <section className="schema-panel">
                    <div className="table-tools">
                        <div className="table-filter-row">
                            <input
                                className="table-filter"
                                value={tableFilter}
                                placeholder="Filter tables..."
                                onChange={(event) => setTableFilter(event.target.value)}
                            />
                            <button className="sidebar-refresh" onClick={() => loadSchema()} disabled={!selectedConnectionId || !selectedDatabase} title="Refresh schema">↻</button>
                        </div>
                    </div>
                    <div className="schema-tree">
                        {filteredSchemaTables.map((table) => (
                            <details className="table-node" key={table.name}>
                                <summary onDoubleClick={() => insertTableReference(table)}>
                                    <span className="table-name">
                                        <span className="table-icon" />
                                        <span>{table.name}</span>
                                        <small>{formatRowCount(table.rowCount)} rows</small>
                                    </span>
                                    <span className="table-meta">{table.indexes?.length || 0} idx</span>
                                </summary>
                                {(table.columns || []).map((column) => (
                                    <div className="column-item" key={`${table.name}.${column.name}`}>
                                        <span>
                                            <span className={columnIconClass(column)}>{columnIconLabel(column)}</span>
                                            {column.name}
                                        </span>
                                        <span title={formatColumnMeta(column)}>{formatColumnMeta(column)}</span>
                                    </div>
                                ))}
                                {(table.indexes || []).length > 0 && (
                                    <div className="index-list">
                                        {(table.indexes || []).map((index) => (
                                            <div className="index-item" key={`${table.name}.${index.name}`}>
                                                <span>{index.name}</span>
                                                <span>{index.unique ? 'UNIQUE' : 'INDEX'} | {index.type} | {(index.columns || []).join(', ')}</span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </details>
                        ))}
                    </div>
                </section>
            )}
            <div className="sidebar-footer">
                <button disabled>▤ Backup & Restore</button>
                <button disabled>ⓘ About All DB Connector</button>
            </div>
        </aside>
    );
}

export default Sidebar;
