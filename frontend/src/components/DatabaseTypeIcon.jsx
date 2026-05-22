function DatabaseTypeIcon({type = 'mysql', className = ''}) {
    const normalized = String(type || 'mysql').toLowerCase();
    const icon = icons[normalized] || icons.mysql;

    return (
        <span className={`database-type-icon ${className}`} style={{'--db-icon-color': icon.color}} aria-label={icon.label}>
            {icon.svg}
        </span>
    );
}

const icons = {
    athena: providerIcon('Amazon Athena', '#fb923c', 'M5 16.5 12 4l7 12.5M8 12h8M6.8 16.5h10.4'),
    redshift: providerIcon('Amazon Redshift', '#3b82f6', 'M5 6.5 12 3l7 3.5v10.8L12 21l-7-3.7V6.5ZM8 8v7.5M12 6.2v12M16 8v7.5'),
    bigquery: providerIcon('BigQuery', '#5b8def', 'M12 4.2 19 8v8l-7 3.8L5 16V8l7-3.8ZM9 12h6M12 9v6'),
    clickhouse: providerIcon('ClickHouse', '#facc15', 'M5 5v14M9 5v14M13 5v14M17 9v6M21 9v6'),
    databricks: providerIcon('Databricks', '#ef4444', 'M4 8 12 4l8 4-8 4-8-4ZM4 12l8 4 8-4M4 16l8 4 8-4'),
    druid: providerIcon('Druid', '#22d3ee', 'M5 8c4.8-3.2 9.2-3.2 14 0M5 12c4.8-3.2 9.2-3.2 14 0M5 16c4.8-3.2 9.2-3.2 14 0'),
    'druid-jdbc': providerIcon('Druid JDBC', '#38bdf8', 'M5 8c4.8-3.2 9.2-3.2 14 0M5 12c4.8-3.2 9.2-3.2 14 0M7 17h10'),
    mysql: {
        label: 'MySQL',
        color: '#3b82f6',
        svg: (
            <svg viewBox="0 0 24 24" role="img">
                <path className="icon-fill" d="M3.5 14.5c2.3-3.9 6.1-5.9 11.4-5.9h2.9c-1 1-1.8 2-2.4 3.2 1.8.2 3.1 1.1 4.1 2.7-2.6-.4-4.7 0-6.5 1.2-2.4 1.6-5.6 1.3-9.5-1.2Z" />
                <path d="M6.4 14.2c2.7 1.3 5 1.3 6.9 0 1.3-.9 2.9-1.4 4.8-1.4" />
                <path d="M14.7 8.7c.8-1.8 2.3-3.1 4.3-3.8-.1 2-.5 3.5-1.2 4.4" />
                <circle cx="8" cy="12.6" r=".8" />
            </svg>
        ),
    },
    postgres: {
        label: 'PostgreSQL',
        color: '#60a5fa',
        svg: (
            <svg viewBox="0 0 24 24" role="img">
                <path className="icon-fill" d="M12 3.5c4.3 0 7.5 2.8 7.5 7.1 0 3.4-2.1 5.7-5.1 6.5l.8 3.4h-3.4l-.6-3.1H9.5c-3 0-5-2.5-5-5.9 0-4.8 3.3-8 7.5-8Z" />
                <path d="M8.6 10.4c0-1.2.7-2 1.8-2 1 0 1.7.8 1.7 2v7" />
                <path d="M12.1 10.4c0-1.2.7-2 1.8-2s1.8.8 1.8 2c0 1.1-.7 1.9-1.8 1.9h-1.8" />
                <path d="M11.3 17.4c-1.7 0-3-.5-3.9-1.5" />
            </svg>
        ),
    },
    mongodb: {
        label: 'MongoDB',
        color: '#22c55e',
        svg: (
            <svg viewBox="0 0 24 24" role="img">
                <path className="icon-fill" d="M12 2.8c4.1 3.6 5.7 7 4.9 10.2-.6 2.6-2.2 4.8-4.9 6.7-2.7-1.9-4.3-4.1-4.9-6.7-.8-3.2.8-6.6 4.9-10.2Z" />
                <path d="M12 4.2v16.9" />
                <path d="M12 9.5c1.3 1.2 2 2.7 2 4.5" />
            </svg>
        ),
    },
    sqlite: {
        label: 'SQLite',
        color: '#f59e0b',
        svg: (
            <svg viewBox="0 0 24 24" role="img">
                <path className="icon-fill" d="M5 18.7c5.2-1.7 9-5.8 11.4-12.3l2.6 1.1c-1.3 5.9-5.1 10.4-11.3 13.5L5 18.7Z" />
                <path d="M4.4 17.7c2.8-.4 5.3-1.6 7.3-3.6" />
                <path d="M13.5 12.1 19.3 5" />
                <path d="M6.3 20.8h11.4" />
            </svg>
        ),
    },
    presto: providerIcon('Presto', '#7dd3fc', 'M6 6.5h9.5c2 0 3.5 1.4 3.5 3.2s-1.5 3.3-3.5 3.3H10v5M10 13V6.5'),
    snowflake: providerIcon('Snowflake', '#38bdf8', 'M12 3v18M5.6 6.6l12.8 10.8M18.4 6.6 5.6 17.4M4 12h16'),
    'spark-sql': providerIcon('Spark SQL', '#f97316', 'M13 3 5 14h6l-1 7 9-12h-6l1-6Z'),
    sqlserver: providerIcon('SQL Server', '#ef4444', 'M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3Zm0 0v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6'),
    starburst: providerIcon('Starburst (Trino)', '#14b8a6', 'M12 3c4.4 3.2 6.6 6.1 6.6 8.8 0 3.8-3 6.7-6.6 9.2-3.6-2.5-6.6-5.4-6.6-9.2C5.4 9.1 7.6 6.2 12 3Zm-3 9h6M12 8v8'),
};

function providerIcon(label, color, path) {
    return {
        label,
        color,
        svg: (
            <svg viewBox="0 0 24 24" role="img">
                <path className="icon-fill" d={path} />
                <path d={path} />
            </svg>
        ),
    };
}

export default DatabaseTypeIcon;
