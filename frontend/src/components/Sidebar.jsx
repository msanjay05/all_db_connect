import CompactSelect from './CompactSelect';
import DatabaseTypeIcon from './DatabaseTypeIcon';
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
    databaseTypeOptions,
    openAboutDialog,
}) {
    const profileType = profileForm.type || 'mysql';
    const isMongo = profileType === 'mongodb';
    const isSQLite = profileType === 'sqlite';
    const isHostSql = ['mysql', 'postgres', 'redshift', 'clickhouse', 'presto', 'starburst', 'sqlserver'].includes(profileType);
    const isCloudWarehouse = ['athena', 'bigquery', 'snowflake', 'databricks'].includes(profileType);
    const isHttpSql = ['druid', 'druid-jdbc', 'spark-sql'].includes(profileType);
    const needsToken = ['databricks', 'druid', 'druid-jdbc', 'spark-sql'].includes(profileType);
    const needsConnectionString = ['clickhouse', 'presto', 'sqlserver', 'mongodb', 'snowflake', 'databricks', 'druid', 'druid-jdbc', 'spark-sql'].includes(profileType);
    const activeProfile = profiles.find((profile) => profile.id === selectedConnectionId);
    const isDefaultDatabase = Boolean(selectedDatabase && activeProfile?.database === selectedDatabase);

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
                            <div className="active-connection-meta" title={connectionTarget(selectedProfile)}>
                                <span className="connection-status-icon connected" aria-hidden="true" />
                                <DatabaseTypeIcon type={selectedProfile.type} />
                                <small>{connectionTarget(selectedProfile)}</small>
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
                    <button className="secondary connection-action-button" onClick={newProfile} title="New connection" aria-label="New connection">
                        <svg className="connection-action-svg" viewBox="0 0 16 16" aria-hidden="true">
                            <path d="M8 3v10M3 8h10" />
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
                                title={`${connectionTarget(profile)} (${isActive ? 'connected' : 'disconnected'})`}
                            >
                                <span className={isActive ? 'connection-status-icon connected' : 'connection-status-icon disconnected'} aria-hidden="true" />
                                <DatabaseTypeIcon type={profile.type} />
                                {profile.name}
                            </button>
                        );
                    })}
                </div>
            </section>

            {showConnectionForm && (
                <section className="panel form-panel">
                    <div className="panel-title">
                        <span>Connection Details</span>
                        <button className="secondary" onClick={closeProfileForm}>Cancel</button>
                    </div>
                    <label>
                        Database Type
                        <CompactSelect
                            className="database-type-select"
                            value={profileType}
                            options={databaseTypeOptions}
                            placeholder="Database type"
                            onChange={(value) => updateProfileField('type', value)}
                        />
                    </label>
                    <label>Name<input value={profileForm.name} onChange={(event) => updateProfileField('name', event.target.value)}/></label>
                    {isHostSql && (
                        <>
                            {needsConnectionString && (
                                <label>Connection String<input value={profileForm.connectionString || ''} onChange={(event) => updateProfileField('connectionString', event.target.value)}/></label>
                            )}
                            <label>Host<input value={profileForm.host} onChange={(event) => updateProfileField('host', event.target.value)}/></label>
                            <label>Port<input type="number" value={profileForm.port || ''} onChange={(event) => updateProfileField('port', event.target.value)}/></label>
                            <label>User<input value={profileForm.username} onChange={(event) => updateProfileField('username', event.target.value)}/></label>
                            <label>Password<input type="password" value={profileForm.password} onChange={(event) => updateProfileField('password', event.target.value)}/></label>
                        </>
                    )}
                    {isMongo && (
                        <>
                            <label>Connection String<input placeholder="mongodb://localhost:27017" value={profileForm.connectionString || ''} onChange={(event) => updateProfileField('connectionString', event.target.value)}/></label>
                            <label>Host<input value={profileForm.host} onChange={(event) => updateProfileField('host', event.target.value)}/></label>
                            <label>Port<input type="number" value={profileForm.port || ''} onChange={(event) => updateProfileField('port', event.target.value)}/></label>
                            <label>Default Database<input value={profileForm.database || ''} onChange={(event) => updateProfileField('database', event.target.value)}/></label>
                            <label>User<input value={profileForm.username} onChange={(event) => updateProfileField('username', event.target.value)}/></label>
                            <label>Password<input type="password" value={profileForm.password} onChange={(event) => updateProfileField('password', event.target.value)}/></label>
                        </>
                    )}
                    {isSQLite && (
                        <label>File Path<input placeholder="/path/to/database.sqlite" value={profileForm.filePath || ''} onChange={(event) => updateProfileField('filePath', event.target.value)}/></label>
                    )}
                    {isCloudWarehouse && (
                        <>
                            {profileType === 'athena' && (
                                <>
                                    <label>Region<input placeholder="us-east-1" value={profileForm.region || ''} onChange={(event) => updateProfileField('region', event.target.value)}/></label>
                                    <label>Catalog<input placeholder="AwsDataCatalog" value={profileForm.account || ''} onChange={(event) => updateProfileField('account', event.target.value)}/></label>
                                    <label>Extra Params<textarea placeholder='{"outputLocation":"s3://bucket/query-results/","workgroup":"primary"}' value={profileForm.extraParams || ''} onChange={(event) => updateProfileField('extraParams', event.target.value)}/></label>
                                </>
                            )}
                            {profileType === 'bigquery' && (
                                <>
                                    <label>Project ID<input value={profileForm.projectId || ''} onChange={(event) => updateProfileField('projectId', event.target.value)}/></label>
                                    <label>Credentials File<input placeholder="/path/to/service-account.json" value={profileForm.filePath || ''} onChange={(event) => updateProfileField('filePath', event.target.value)}/></label>
                                    <label>Location<input placeholder="US" value={profileForm.region || ''} onChange={(event) => updateProfileField('region', event.target.value)}/></label>
                                </>
                            )}
                            {profileType === 'snowflake' && (
                                <>
                                    <label>Connection String<input value={profileForm.connectionString || ''} onChange={(event) => updateProfileField('connectionString', event.target.value)}/></label>
                                    <label>Account<input value={profileForm.account || ''} onChange={(event) => updateProfileField('account', event.target.value)}/></label>
                                    <label>User<input value={profileForm.username} onChange={(event) => updateProfileField('username', event.target.value)}/></label>
                                    <label>Password<input type="password" value={profileForm.password} onChange={(event) => updateProfileField('password', event.target.value)}/></label>
                                    <label>Warehouse<input value={profileForm.warehouse || ''} onChange={(event) => updateProfileField('warehouse', event.target.value)}/></label>
                                    <label>Role<input value={profileForm.role || ''} onChange={(event) => updateProfileField('role', event.target.value)}/></label>
                                </>
                            )}
                            {profileType === 'databricks' && (
                                <>
                                    <label>Host<input placeholder="https://workspace.cloud.databricks.com" value={profileForm.host} onChange={(event) => updateProfileField('host', event.target.value)}/></label>
                                    <label>SQL Warehouse ID<input value={profileForm.warehouse || ''} onChange={(event) => updateProfileField('warehouse', event.target.value)}/></label>
                                    <label>Access Token<input type="password" value={profileForm.password} onChange={(event) => updateProfileField('password', event.target.value)}/></label>
                                    <label>Extra Params<textarea placeholder='{"warehouse_id":"..."}' value={profileForm.extraParams || ''} onChange={(event) => updateProfileField('extraParams', event.target.value)}/></label>
                                </>
                            )}
                        </>
                    )}
                    {isHttpSql && (
                        <>
                            <label>Endpoint<input placeholder={profileType === 'spark-sql' ? 'http://host:port' : 'http://host:8888'} value={profileForm.connectionString || profileForm.host || ''} onChange={(event) => updateProfileField('connectionString', event.target.value)}/></label>
                            {needsToken && <label>Access Token<input type="password" value={profileForm.password} onChange={(event) => updateProfileField('password', event.target.value)}/></label>}
                            <label>Extra Params<textarea placeholder={profileType === 'spark-sql' ? '{"endpoint":"/sql"}' : '{"timeout":"30s"}'} value={profileForm.extraParams || ''} onChange={(event) => updateProfileField('extraParams', event.target.value)}/></label>
                        </>
                    )}
                    <label className="checkbox-label">
                        <input
                            type="checkbox"
                            checked={Boolean(profileForm.readOnly)}
                            onChange={(event) => updateProfileField('readOnly', event.target.checked)}
                        />
                        Read only ({isMongo ? 'read commands only' : 'DQL queries only'})
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
                    <div className="database-action-row">
                        <CompactSelect
                            className="database-select"
                            value={selectedDatabase}
                            options={databaseOptions}
                            placeholder="Select database"
                            disabled={!selectedConnectionId || databases.length === 0}
                            onChange={selectDatabase}
                        />
                        <button
                            className={isDefaultDatabase ? 'default-database-button active' : 'default-database-button'}
                            onClick={() => setDefaultDatabase()}
                            disabled={!selectedDatabase || isDefaultDatabase}
                            title={isDefaultDatabase ? 'Selected database is default' : 'Mark selected database as default'}
                        >
                            <span className="default-database-icon" aria-hidden="true">★</span>
                            {isDefaultDatabase ? 'Default' : 'Set default'}
                        </button>
                        <button className="sidebar-refresh" onClick={() => loadDatabases()} disabled={!selectedConnectionId} title="Refresh databases">↻</button>
                    </div>
                    {selectedConnectionId && databases.length === 0 && (
                        <div className="hint">No databases loaded yet. Use Refresh after selecting a connection.</div>
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
                <button onClick={openAboutDialog}>ⓘ About All DB Connector</button>
            </div>
        </aside>
    );
}

export default Sidebar;

function connectionTarget(profile) {
    if (!profile) {
        return '';
    }
    if ((profile.type || 'mysql') === 'sqlite') {
        return profile.filePath || 'SQLite file';
    }
    if ((profile.type || 'mysql') === 'mongodb' && profile.connectionString) {
        return 'MongoDB connection string';
    }
    return profile.host || profile.connectionString || profile.filePath || '';
}
