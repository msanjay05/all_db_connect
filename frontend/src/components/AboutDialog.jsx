function AboutDialog({onClose}) {
    return (
        <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
            <div className="about-dialog" role="dialog" aria-modal="true" aria-label="About All DB Connector" onMouseDown={(event) => event.stopPropagation()}>
                <div className="panel-title">
                    <span>About All DB Connector</span>
                    <button className="secondary" onClick={onClose} aria-label="Close about dialog">Close</button>
                </div>
                <p>
                    All DB Connector is a desktop database workbench for managing connections, browsing schemas,
                    running queries, exporting results, and editing result rows where supported.
                </p>
                <div className="about-grid">
                    <span>Supported databases</span>
                    <strong>MySQL, PostgreSQL, MongoDB, SQLite, Athena, Redshift, BigQuery, ClickHouse, Databricks, Druid, Presto, Snowflake, Spark SQL, SQL Server, Starburst/Trino</strong>
                    <span>Safety</span>
                    <strong>Read-only profiles block write queries where applicable.</strong>
                    <span>Workspace</span>
                    <strong>Query tabs are saved per connection and restored across restarts.</strong>
                </div>
            </div>
        </div>
    );
}

export default AboutDialog;
