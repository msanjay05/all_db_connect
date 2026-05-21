import {memo, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import Editor from '@monaco-editor/react';
import './App.css';
import {
    DeleteConnectionProfile,
    ExecuteQuery,
    GetSchema,
    KillQuery,
    ListDatabases,
    ListConnectionProfiles,
    ListQueryHistory,
    SaveCSVFile,
    SaveConnectionProfile,
    SetDefaultDatabase,
    TestConnection,
} from "../wailsjs/go/main/App";
import {ClipboardSetText} from "../wailsjs/runtime/runtime";

const defaultProfile = {
    id: '',
    name: 'Local MySQL',
    host: '127.0.0.1',
    port: 3306,
    username: 'root',
    password: '',
    readOnly: false,
};

const mysqlKeywords = [
    'SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN',
    'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'INSERT', 'UPDATE', 'DELETE',
    'CREATE', 'ALTER', 'DROP', 'TABLE', 'DATABASE', 'INDEX', 'VIEW', 'TRIGGER',
    'PROCEDURE', 'SHOW', 'DESCRIBE', 'EXPLAIN', 'COUNT', 'SUM', 'AVG', 'MIN',
    'MAX', 'DISTINCT', 'AS', 'ON', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'LIKE',
    'IN', 'BETWEEN', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
];
const DEFAULT_RESULT_PAGE_SIZE = 50;

function createQueryTab(id) {
    return {
        id,
        title: `Query ${id}`,
        sql: 'SELECT * FROM ',
        limit: 100,
        result: null,
        showFilters: false,
        columnFilters: {},
        sort: {column: '', direction: ''},
        resultPage: 1,
        resultPageSize: DEFAULT_RESULT_PAGE_SIZE,
    };
}

function normalizeWorkspace(workspace) {
    const tabs = Array.isArray(workspace?.queryTabs) && workspace.queryTabs.length
        ? workspace.queryTabs
        : [createQueryTab(1)];
    const activeTabId = tabs.some((tab) => tab.id === workspace?.activeTabId)
        ? workspace.activeTabId
        : tabs[0].id;
    return {queryTabs: tabs, activeTabId};
}

function App() {
    const [profiles, setProfiles] = useState([]);
    const [selectedConnectionId, setSelectedConnectionId] = useState('');
    const [profileForm, setProfileForm] = useState(defaultProfile);
    const [showConnectionForm, setShowConnectionForm] = useState(false);
    const [connectionTestStatus, setConnectionTestStatus] = useState('');
    const [databases, setDatabases] = useState([]);
    const [selectedDatabase, setSelectedDatabase] = useState('');
    const [schema, setSchema] = useState({database: '', tables: []});
    const [queryTabs, setQueryTabs] = useState(() => [createQueryTab(1)]);
    const [activeTabId, setActiveTabId] = useState(1);
    const [connectionWorkspaces, setConnectionWorkspaces] = useState({});
    const [history, setHistory] = useState([]);
    const [showHistory, setShowHistory] = useState(false);
    const [tableFilter, setTableFilter] = useState('');
    const [status, setStatus] = useState('Ready');
    const [isRunning, setIsRunning] = useState(false);
    const [resultEdits, setResultEdits] = useState({});
    const [pendingUpdateBatch, setPendingUpdateBatch] = useState(null);
    const schemaRef = useRef(schema);
    const editorRef = useRef(null);
    const runQueryRef = useRef(() => {});
    const activeTabIdRef = useRef(activeTabId);
    const queryTabsRef = useRef(queryTabs);
    const selectedConnectionIdRef = useRef(selectedConnectionId);
    const selectedDatabaseRef = useRef(selectedDatabase);
    const connectionWorkspacesRef = useRef(connectionWorkspaces);

    useEffect(() => {
        schemaRef.current = schema;
    }, [schema]);

    useEffect(() => {
        refreshProfiles();
        refreshHistory();
    }, []);

    const selectedProfile = useMemo(
        () => profiles.find((profile) => profile.id === selectedConnectionId),
        [profiles, selectedConnectionId],
    );

    const activeTab = useMemo(
        () => queryTabs.find((tab) => tab.id === activeTabId) || queryTabs[0],
        [queryTabs, activeTabId],
    );

    const activeResultRows = activeTab?.result?.rows || [];
    const activeResultColumns = activeTab?.result?.columns || [];
    const activeColumnFilters = activeTab?.columnFilters || {};
    const activeSort = activeTab?.sort || {column: '', direction: ''};
    const activeResultPageSize = activeTab?.resultPageSize || DEFAULT_RESULT_PAGE_SIZE;
    const activeResultPage = activeTab?.resultPage || 1;
    const editableTableName = useMemo(() => inferEditableTableName(activeTab?.sql || ''), [activeTab?.sql]);
    const canEditResults = Boolean(selectedProfile && !selectedProfile.readOnly && editableTableName);
    const resultEditItems = useMemo(() => Object.values(resultEdits), [resultEdits]);
    const resultEditCount = resultEditItems.length;
    const resultPrimaryKeyNames = useMemo(
        () => primaryKeyNamesForTable(schema, editableTableName),
        [schema, editableTableName],
    );
    const sortedResultColumns = useMemo(
        () => sortColumnsByName(activeResultColumns, resultPrimaryKeyNames),
        [activeResultColumns, resultPrimaryKeyNames],
    );

    const filteredRows = useMemo(() => {
        const columnsByName = new Map(activeResultColumns.map((column) => [column.name, column]));
        const filters = Object.entries(activeColumnFilters)
            .map(([column, value]) => [column, String(value || '').trim()])
            .filter(([, value]) => value !== '');
        const rows = filters.length === 0
            ? activeResultRows
            : activeResultRows.filter((row) => filters.every(([column, value]) => {
            const resultColumn = columnsByName.get(column);
            if (isSpecialFilter(value)) {
                return matchesSpecialFilter(row[column], value);
            }
            if (isDateColumn(resultColumn) && value.startsWith('datecmp:')) {
                return matchesDateComparison(row[column], value);
            }
            if (isDateColumn(resultColumn) && value.startsWith('date:')) {
                return matchesDatePreset(row[column], value);
            }
            if (isNumericColumn(resultColumn) && value.startsWith('num:')) {
                return matchesNumericFilter(row[column], value);
            }
            return String(row[column] ?? '').toLowerCase().includes(value.toLowerCase());
        }));
        if (!activeSort.column || !activeSort.direction) {
            return rows;
        }
        return [...rows].sort((left, right) =>
            compareSortValues(left[activeSort.column], right[activeSort.column]) * (activeSort.direction === 'desc' ? -1 : 1),
        );
    }, [activeResultRows, activeResultColumns, activeColumnFilters, activeSort]);

    const resultPageCount = Math.max(1, Math.ceil(filteredRows.length / activeResultPageSize));
    const currentResultPage = Math.min(Math.max(activeResultPage, 1), resultPageCount);
    const resultPageStart = (currentResultPage - 1) * activeResultPageSize;
    const paginatedRows = useMemo(
        () => filteredRows.slice(resultPageStart, resultPageStart + activeResultPageSize),
        [filteredRows, resultPageStart, activeResultPageSize],
    );

    const filteredSchemaTables = useMemo(() => {
        const search = tableFilter.trim().toLowerCase();
        const tables = (schema.tables || []).map((table) => ({
            ...table,
            columns: sortColumnsByName(table.columns || []),
        }));
        if (!search) {
            return tables;
        }
        return tables.filter((table) =>
            table.name.toLowerCase().includes(search)
            || (table.columns || []).some((column) => column.name.toLowerCase().includes(search)),
        );
    }, [schema, tableFilter]);

    useEffect(() => {
        runQueryRef.current = runQuery;
    });

    useEffect(() => {
        activeTabIdRef.current = activeTabId;
        queryTabsRef.current = queryTabs;
        selectedConnectionIdRef.current = selectedConnectionId;
        selectedDatabaseRef.current = selectedDatabase;
    }, [activeTabId, queryTabs, selectedConnectionId, selectedDatabase]);

    useEffect(() => {
        connectionWorkspacesRef.current = connectionWorkspaces;
    }, [connectionWorkspaces]);

    useEffect(() => {
        setResultEdits({});
        setPendingUpdateBatch(null);
    }, [activeTabId, selectedConnectionId, selectedDatabase]);

    useEffect(() => {
        if (!selectedConnectionId) {
            return;
        }
        setConnectionWorkspaces((current) => ({
            ...current,
            [selectedConnectionId]: normalizeWorkspace({queryTabs, activeTabId}),
        }));
    }, [queryTabs, activeTabId, selectedConnectionId]);

    const updateQueryTab = useCallback((tabId, updater) => {
        setQueryTabs((currentTabs) => currentTabs.map((tab) => {
            if (tab.id !== tabId) {
                return tab;
            }
            const patch = typeof updater === 'function' ? updater(tab) : updater;
            return {...tab, ...patch};
        }));
    }, []);

    const updateActiveTab = useCallback((updater) => {
        updateQueryTab(activeTabIdRef.current, updater);
    }, [updateQueryTab]);

    function addQueryTab() {
        const nextId = Math.max(...queryTabs.map((tab) => tab.id), 0) + 1;
        setQueryTabs((currentTabs) => [...currentTabs, createQueryTab(nextId)]);
        setActiveTabId(nextId);
    }

    function closeQueryTab(tabId) {
        if (queryTabs.length === 1) {
            return;
        }
        const remainingTabs = queryTabs.filter((tab) => tab.id !== tabId);
        setQueryTabs(remainingTabs);
        if (activeTabId === tabId) {
            setActiveTabId(remainingTabs[0].id);
        }
    }

    function toggleColumnFilters() {
        updateActiveTab((tab) => ({showFilters: !tab.showFilters}));
    }

    const updateColumnFilter = useCallback((column, value) => {
        updateActiveTab((tab) => ({
            columnFilters: {
                ...(tab.columnFilters || {}),
                [column]: value,
            },
            resultPage: 1,
        }));
    }, [updateActiveTab]);

    const clearColumnFilter = useCallback((column) => {
        updateActiveTab((tab) => {
            const nextFilters = {...(tab.columnFilters || {})};
            delete nextFilters[column];
            return {columnFilters: nextFilters, resultPage: 1};
        });
    }, [updateActiveTab]);

    function clearAllColumnFilters() {
        updateActiveTab({columnFilters: {}, resultPage: 1});
    }

    const toggleResultSort = useCallback((column) => {
        updateActiveTab((tab) => {
            const current = tab.sort || {column: '', direction: ''};
            if (current.column !== column) {
                return {sort: {column, direction: 'asc'}, resultPage: 1};
            }
            if (current.direction === 'asc') {
                return {sort: {column, direction: 'desc'}, resultPage: 1};
            }
            return {sort: {column: '', direction: ''}, resultPage: 1};
        });
    }, [updateActiveTab]);

    const updateResultPage = useCallback((page) => {
        updateActiveTab({resultPage: page});
    }, [updateActiveTab]);

    const updateResultPageSize = useCallback((pageSize) => {
        updateActiveTab({resultPageSize: pageSize, resultPage: 1});
    }, [updateActiveTab]);

    const copyText = useCallback(async (text, message) => {
        try {
            await ClipboardSetText(text);
            setStatus(message);
        } catch (error) {
            setStatus(errorMessage(error));
        }
    }, []);

    function currentWorkspaceSnapshot() {
        const tabs = queryTabsRef.current.length ? queryTabsRef.current : [createQueryTab(1)];
        const activeId = activeTabIdRef.current || tabs[0].id;
        const editorSql = editorRef.current?.getValue?.();
        const snapshotTabs = tabs.map((tab) =>
            tab.id === activeId && editorSql !== undefined ? {...tab, sql: editorSql} : tab,
        );
        return normalizeWorkspace({queryTabs: snapshotTabs, activeTabId: activeId});
    }

    function restoreConnectionWorkspace(connectionId) {
        const workspace = normalizeWorkspace(connectionWorkspacesRef.current[connectionId]);
        setQueryTabs(workspace.queryTabs);
        setActiveTabId(workspace.activeTabId);
    }

    async function refreshProfiles() {
        try {
            const items = await ListConnectionProfiles();
            setProfiles(items || []);
        } catch (error) {
            setStatus(errorMessage(error));
        }
    }

    async function refreshHistory() {
        try {
            setHistory((await ListQueryHistory(10)) || []);
        } catch (error) {
            setStatus(errorMessage(error));
        }
    }

    async function toggleHistory() {
        if (!showHistory) {
            await refreshHistory();
        }
        setShowHistory((current) => !current);
    }

    function updateProfileField(field, value) {
        setProfileForm((current) => ({
            ...current,
            [field]: field === 'port' ? Number(value) : value,
        }));
    }

    function handleConnectionChange(connectionID) {
        const profile = profiles.find((item) => item.id === connectionID);
        if (profile) {
            selectProfile(profile);
        }
    }

    function selectProfile(profile) {
        const currentConnectionId = selectedConnectionIdRef.current;
        if (currentConnectionId) {
            setConnectionWorkspaces((current) => ({
                ...current,
                [currentConnectionId]: currentWorkspaceSnapshot(),
            }));
        }
        restoreConnectionWorkspace(profile.id);
        setSelectedConnectionId(profile.id);
        setShowConnectionForm(false);
        setProfileForm(defaultProfile);
        setDatabases([]);
        setSelectedDatabase('');
        setSchema({database: '', tables: []});
        setStatus(`Selected ${profile.name}`);
        loadDatabases(profile.id, profile.database);
    }

    function newProfile() {
        setShowConnectionForm(true);
        setProfileForm(defaultProfile);
        setConnectionTestStatus('');
        setStatus('Enter connection details and save');
    }

    function editProfile() {
        const profile = profiles.find((item) => item.id === selectedConnectionId);
        if (!profile) {
            setStatus('Select a connection to edit');
            return;
        }
        setShowConnectionForm(true);
        setProfileForm({
            id: profile.id,
            name: profile.name,
            host: profile.host,
            port: profile.port || 3306,
            username: profile.username,
            password: '',
            database: profile.database || '',
            readOnly: Boolean(profile.readOnly),
        });
        setConnectionTestStatus('');
        setStatus(`Editing ${profile.name}. Leave password blank to keep the saved password.`);
    }

    function closeProfileForm() {
        setShowConnectionForm(false);
        setProfileForm(defaultProfile);
        setConnectionTestStatus('');
        setStatus('Connection details cleared');
    }

    async function loadDatabases(connectionId = selectedConnectionId, defaultDatabase = '') {
        if (!connectionId) {
            return;
        }
        try {
            const loadedDatabases = await ListDatabases(connectionId);
            setDatabases(loadedDatabases || []);
            const databaseToSelect = defaultDatabase && loadedDatabases?.includes(defaultDatabase) ? defaultDatabase : '';
            setSelectedDatabase(databaseToSelect);
            if (databaseToSelect) {
                loadSchema(connectionId, databaseToSelect);
            } else {
                setSchema({database: '', tables: []});
            }
            setStatus(`Loaded ${loadedDatabases?.length || 0} databases`);
        } catch (error) {
            setDatabases([]);
            setSelectedDatabase('');
            setSchema({database: '', tables: []});
            setStatus(errorMessage(error));
        }
    }

    function selectDatabase(database) {
        setSelectedDatabase(database);
        setStatus(`Selected database ${database}`);
        loadSchema(selectedConnectionId, database);
        const profile = profiles.find((item) => item.id === selectedConnectionId);
        if (database && profile && profile.database !== database && window.confirm(`Set "${database}" as the default database for ${profile.name}?`)) {
            setDefaultDatabase(database);
        }
    }

    async function setDefaultDatabase(database = selectedDatabase) {
        if (!selectedConnectionId || !database) {
            return;
        }
        try {
            const updated = await SetDefaultDatabase(selectedConnectionId, database);
            setProfiles((current) => current.map((profile) => profile.id === updated.id ? updated : profile));
            setStatus(`Default database set to ${database}`);
        } catch (error) {
            setStatus(errorMessage(error));
        }
    }

    async function saveProfile() {
        try {
            const saved = await SaveConnectionProfile({...profileForm, database: ''});
            setSelectedConnectionId(saved.id);
            setProfileForm(defaultProfile);
            setShowConnectionForm(false);
            if (!profileForm.id) {
                setDatabases([]);
                setSelectedDatabase('');
                setSchema({database: '', tables: []});
            }
            setStatus(`Saved ${saved.name}`);
            await refreshProfiles();
            await loadDatabases(saved.id, saved.database);
        } catch (error) {
            setStatus(errorMessage(error));
        }
    }

    async function deleteProfile() {
        if (!selectedConnectionId) {
            return;
        }
        const profile = profiles.find((item) => item.id === selectedConnectionId);
        if (!window.confirm(`Remove connection "${profile?.name || 'selected connection'}"?`)) {
            return;
        }
        try {
            await DeleteConnectionProfile(selectedConnectionId);
            setConnectionWorkspaces((current) => {
                const next = {...current};
                delete next[selectedConnectionId];
                return next;
            });
            setSelectedConnectionId('');
            setQueryTabs([createQueryTab(1)]);
            setActiveTabId(1);
            setDatabases([]);
            setSelectedDatabase('');
            setSchema({database: '', tables: []});
            await refreshProfiles();
            setStatus('Deleted connection profile');
        } catch (error) {
            setStatus(errorMessage(error));
        }
    }

    async function testConnection() {
        setConnectionTestStatus('Testing connection...');
        try {
            const response = await TestConnection(profileForm);
            setConnectionTestStatus(response.message);
        } catch (error) {
            setConnectionTestStatus(errorMessage(error));
        }
    }

    async function loadSchema(connectionId = selectedConnectionId, database = selectedDatabase) {
        if (!connectionId || !database) {
            return;
        }
        try {
            const loaded = await GetSchema({connectionId, database});
            setSchema(loaded || {database: '', tables: []});
            setStatus(`Loaded schema for ${loaded.database || 'connection'}`);
        } catch (error) {
            setSchema({database: '', tables: []});
            setStatus(errorMessage(error));
        }
    }

    async function runQuery() {
        await executeCurrentSql('run');
    }

    async function explainQuery() {
        await executeCurrentSql('explain');
    }

    async function executeCurrentSql(mode) {
        const connectionID = selectedConnectionIdRef.current;
        const database = selectedDatabaseRef.current;
        const tabId = activeTabIdRef.current;
        const tab = queryTabsRef.current.find((item) => item.id === tabId);
        const fullSql = editorRef.current?.getValue?.() ?? tab?.sql ?? '';
        const executableSql = getExecutableSql(editorRef.current, fullSql);
        const sql = mode === 'explain' ? buildExplainSql(executableSql) : executableSql;

        if (!connectionID) {
            setStatus('Select or save a connection first');
            return;
        }
        if (!database) {
            setStatus('Select a database first');
            return;
        }
        if (!tab) {
            return;
        }
        if (!executableSql.trim()) {
            setStatus('No SQL statement found to run');
            return;
        }
        setIsRunning(true);
        updateQueryTab(tabId, {sql: fullSql, result: null, resultPage: 1});
        setResultEdits({});
        setPendingUpdateBatch(null);
        setStatus(mode === 'explain' ? 'Explaining query...' : 'Running query...');
        try {
            const result = await ExecuteQuery({connectionId: connectionID, database, sql, limit: tab.limit || 100});
            updateQueryTab(tabId, {result, resultPage: 1});
            setStatus(result.success ? `${mode === 'explain' ? 'Explain completed' : 'Query completed'} in ${result.durationMs} ms` : result.error);
            refreshHistory();
        } catch (error) {
            setStatus(errorMessage(error));
        } finally {
            setIsRunning(false);
        }
    }

    async function killQuery() {
        setStatus('Sending stop request...');
        try {
            const killed = await KillQuery();
            setStatus(killed ? 'Stop requested for the running query' : 'No query is currently running');
        } catch (error) {
            setStatus(errorMessage(error));
        }
    }

    const requestCellUpdate = useCallback((row, column, nextValue) => {
        if (!canEditResults) {
            setStatus(selectedProfile?.readOnly ? 'Read-only connections cannot edit result rows' : 'Run a simple SELECT from one table to edit results');
            return;
        }
        if (isPrimaryKeyColumn(column, resultPrimaryKeyNames)) {
            setStatus('Primary key columns cannot be edited');
            return;
        }
        const rowKey = getRowKey(row, resultPrimaryKeyNames);
        if (!rowKey) {
            setStatus('Cannot update this row because the primary key is not in the result');
            return;
        }
        const originalValue = formatValue(row[column.name]);
        const editKey = makeResultEditKey(rowKey.name, rowKey.value, column.name);
        if (String(nextValue) === originalValue) {
            setResultEdits((current) => {
                const next = {...current};
                delete next[editKey];
                const nextCount = Object.keys(next).length;
                setStatus(nextCount ? `${nextCount} pending edit${nextCount === 1 ? '' : 's'}` : 'No pending edits');
                return next;
            });
            return;
        }
        const updateSql = buildUpdateSql(editableTableName, column, nextValue, rowKey);
        if (!updateSql) {
            setStatus('Could not build update query for this value');
            return;
        }
        setResultEdits((current) => {
            const next = {
                ...current,
                [editKey]: {
                    key: editKey,
                    sql: updateSql,
                    tableName: editableTableName,
                    columnName: column.name,
                    rowKey,
                    originalValue,
                    nextValue: String(nextValue),
                },
            };
            const nextCount = Object.keys(next).length;
            setStatus(`${nextCount} pending edit${nextCount === 1 ? '' : 's'}`);
            return next;
        });
    }, [canEditResults, editableTableName, resultPrimaryKeyNames, selectedProfile]);

    function cancelResultEdits() {
        setResultEdits({});
        setPendingUpdateBatch(null);
        setStatus('Pending result edits cancelled');
    }

    function showResultUpdateConfirmation() {
        if (resultEditItems.length === 0) {
            return;
        }
        setPendingUpdateBatch({
            edits: resultEditItems,
            sql: resultEditItems.map((edit) => edit.sql).join(';\n') + ';',
        });
    }

    async function runPendingUpdateBatch() {
        if (!pendingUpdateBatch || !selectedConnectionId || !selectedDatabase) {
            setPendingUpdateBatch(null);
            return;
        }
        setIsRunning(true);
        setStatus(`Running ${pendingUpdateBatch.edits.length} update${pendingUpdateBatch.edits.length === 1 ? '' : 's'}...`);
        try {
            let updatedRows = 0;
            for (const edit of pendingUpdateBatch.edits) {
                const result = await ExecuteQuery({
                    connectionId: selectedConnectionId,
                    database: selectedDatabase,
                    sql: edit.sql,
                    limit: -1,
                });
                if (!result.success) {
                    setStatus(result.error || `Update failed for ${edit.columnName}`);
                    return;
                }
                updatedRows += result.rowsAffected || 0;
            }
            const editCount = pendingUpdateBatch.edits.length;
            setPendingUpdateBatch(null);
            setResultEdits({});
            setStatus(`Applied ${editCount} edit${editCount === 1 ? '' : 's'} across ${updatedRows} row update${updatedRows === 1 ? '' : 's'}`);
            await executeCurrentSql('run');
        } catch (error) {
            setStatus(errorMessage(error));
        } finally {
            setIsRunning(false);
        }
    }

    function formatQuery() {
        const editor = editorRef.current;
        const tabId = activeTabIdRef.current;
        const tab = queryTabsRef.current.find((item) => item.id === tabId);
        const sql = editor?.getValue?.() ?? tab?.sql ?? '';
        const formatted = formatSql(sql);
        if (!formatted.trim()) {
            setStatus('No SQL to format');
            return;
        }
        if (editor) {
            editor.setValue(formatted);
            editor.focus();
        }
        updateQueryTab(tabId, {sql: formatted});
        setStatus('Formatted SQL');
    }

    function saveQuery() {
        const tabId = activeTabIdRef.current;
        const tab = queryTabsRef.current.find((item) => item.id === tabId);
        const sql = editorRef.current?.getValue?.() ?? tab?.sql ?? '';
        if (!sql.trim()) {
            setStatus('No SQL to save');
            return;
        }

        const blob = new Blob([sql.trim() + '\n'], {type: 'text/sql;charset=utf-8'});
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `${sanitizeFileName(tab?.title || 'query')}.sql`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(link.href);
        setStatus('Saved query as SQL file');
    }

    async function exportCsv() {
        const connectionID = selectedConnectionIdRef.current;
        const database = selectedDatabaseRef.current;
        const tabId = activeTabIdRef.current;
        const tab = queryTabsRef.current.find((item) => item.id === tabId);
        const fullSql = editorRef.current?.getValue?.() ?? tab?.sql ?? '';
        const sql = getExecutableSql(editorRef.current, fullSql);

        if (!connectionID) {
            setStatus('Select or save a connection first');
            return;
        }
        if (!database) {
            setStatus('Select a database first');
            return;
        }
        if (!tab) {
            return;
        }
        if (!sql.trim()) {
            setStatus('No SQL statement found to export');
            return;
        }

        setIsRunning(true);
        updateQueryTab(tabId, {sql: fullSql});
        setStatus('Exporting full result set to CSV...');
        try {
            const result = await ExecuteQuery({connectionId: connectionID, database, sql, limit: -1});
            if (!result.success) {
                setStatus(result.error || 'CSV export failed');
                return;
            }
            if (!result.columns?.length) {
                setStatus('Query did not return columns to export');
                return;
            }

            const path = await SaveCSVFile(
                `${sanitizeFileName(tab.title || 'query-results')}.csv`,
                resultToCsv(result.columns, result.rows || []),
            );
            if (!path) {
                setStatus('CSV export cancelled');
                return;
            }
            setStatus(`Exported ${result.rows?.length || 0} rows to ${path}`);
            refreshHistory();
        } catch (error) {
            setStatus(errorMessage(error));
        } finally {
            setIsRunning(false);
        }
    }

    function insertTableReference(table) {
        const text = `${quoteIdentifier(table.name)} ${buildAlias(table.name)}`;
        const editor = editorRef.current;
        if (!editor) {
            updateActiveTab((tab) => ({sql: `${tab.sql}${text}`}));
            return;
        }

        editor.executeEdits('insert-table-reference', [{
            range: editor.getSelection(),
            text,
            forceMoveMarkers: true,
        }]);
        editor.focus();
        updateActiveTab({sql: editor.getValue()});
    }

    function handleEditorMount(editor, monaco) {
        editorRef.current = editor;
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
            runQueryRef.current();
        });
        monaco.languages.registerCompletionItemProvider('sql', {
            provideCompletionItems: () => ({
                suggestions: buildSuggestions(monaco, schemaRef.current),
            }),
        });
        editor.focus();
    }

    return (
        <div className={showHistory ? 'workbench show-history' : 'workbench'}>
            <aside className="sidebar">
                <section className="sidebar-connection-card">
                    <div className="active-connection-row">
                        <div className="active-connection-select">
                            <select
                                value={selectedConnectionId}
                                onChange={(event) => handleConnectionChange(event.target.value)}
                            >
                                <option value="">Select connection</option>
                                {profiles.map((profile) => (
                                    <option key={profile.id} value={profile.id}>{profile.name}</option>
                                ))}
                            </select>
                            {selectedProfile && (
                                <div className="active-connection-meta" title={selectedProfile.host}>
                                    <span className="connection-status-icon connected" aria-hidden="true" />
                                    <small>{selectedProfile.host}</small>
                                </div>
                            )}
                        </div>
                        <button className="secondary connection-action-button" onClick={editProfile} disabled={!selectedConnectionId} title="Edit connection">
                            ✎
                        </button>
                        <button className="danger connection-action-button" onClick={deleteProfile} disabled={!selectedConnectionId} title="Remove connection">
                            ×
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
                    <select
                        className="database-select"
                        value={selectedDatabase}
                        disabled={!selectedConnectionId || databases.length === 0}
                        onChange={(event) => selectDatabase(event.target.value)}
                    >
                        <option value="">Select database</option>
                        {databases.map((database) => (
                            <option key={database} value={database}>{database}</option>
                        ))}
                    </select>
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

            <main className="main">
                {!selectedConnectionId ? (
                    <section className="editor-empty-state">
                        <strong>Select or add a connection</strong>
                        <span>The SQL editor will appear after a connection is active.</span>
                    </section>
                ) : (
                <>
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

                <section className="editor-panel">
                    <Editor
                        height="100%"
                        key={activeTab?.id}
                        defaultLanguage="sql"
                        theme="vs-dark"
                        value={activeTab?.sql || ''}
                        onChange={(value) => updateActiveTab({sql: value || ''})}
                        onMount={handleEditorMount}
                        options={{
                            minimap: {enabled: false},
                            fontSize: 14,
                            automaticLayout: true,
                            wordWrap: 'on',
                        }}
                    />
                </section>

                <section className="results-panel">
                    <div className="results-header">
                        <strong>Results</strong>
                        <div className="result-filter-actions">
                            {resultEditCount > 0 && (
                                <div className="result-edit-actions">
                                    <span>{resultEditCount} edit{resultEditCount === 1 ? '' : 's'}</span>
                                    <button className="secondary" onClick={cancelResultEdits} disabled={isRunning}>
                                        Cancel
                                    </button>
                                    <button onClick={showResultUpdateConfirmation} disabled={isRunning}>
                                        Update
                                    </button>
                                </div>
                            )}
                            <button
                                className={activeTab?.showFilters ? 'filter-toggle active' : 'filter-toggle'}
                                disabled={!activeTab?.result?.columns?.length}
                                onClick={toggleColumnFilters}
                                title="Show column filters"
                            >
                                ⌕ Filter
                            </button>
                            <button
                                className="clear-filters-button"
                                disabled={!Object.values(activeTab?.columnFilters || {}).some((value) => String(value || '').trim())}
                                onClick={clearAllColumnFilters}
                                title="Clear all filters"
                            >
                                ⊗
                            </button>
                            <button
                                className="filter-toggle"
                                disabled={isRunning || !selectedConnectionId || !selectedDatabase}
                                onClick={exportCsv}
                                title="Export full current query result to CSV"
                            >
                                CSV
                            </button>
                        </div>
                    </div>
                    {activeTab?.result?.error && <div className="error-box">{activeTab.result.error}</div>}
                    <ResultGrid
                        columns={sortedResultColumns}
                        rows={paginatedRows}
                        rowOffset={resultPageStart}
                        showFilters={activeTab?.showFilters}
                        columnFilters={activeTab?.columnFilters || {}}
                        onFilterChange={updateColumnFilter}
                        onFilterClear={clearColumnFilter}
                        onCopyText={copyText}
                        sort={activeSort}
                        onSort={toggleResultSort}
                        canEdit={canEditResults}
                        edits={resultEdits}
                        primaryKeyNames={resultPrimaryKeyNames}
                        onCellUpdate={requestCellUpdate}
                    />
                    {activeTab?.result?.columns?.length > 0 && (
                        <div className="pagination-bar">
                            <span>
                                {filteredRows.length === 0
                                    ? '0 rows'
                                    : `${resultPageStart + 1}-${resultPageStart + paginatedRows.length} of ${filteredRows.length} rows`}
                            </span>
                            <div className="pagination-controls">
                                <label>
                                    Rows
                                    <select
                                        value={activeResultPageSize}
                                        onChange={(event) => updateResultPageSize(Number(event.target.value))}
                                    >
                                        <option value="25">25</option>
                                        <option value="50">50</option>
                                        <option value="100">100</option>
                                        <option value="250">250</option>
                                    </select>
                                </label>
                                <button type="button" onClick={() => updateResultPage(1)} disabled={currentResultPage === 1}>
                                    First
                                </button>
                                <button type="button" onClick={() => updateResultPage(currentResultPage - 1)} disabled={currentResultPage === 1}>
                                    Prev
                                </button>
                                <span>Page {currentResultPage} of {resultPageCount}</span>
                                <button type="button" onClick={() => updateResultPage(currentResultPage + 1)} disabled={currentResultPage === resultPageCount}>
                                    Next
                                </button>
                                <button type="button" onClick={() => updateResultPage(resultPageCount)} disabled={currentResultPage === resultPageCount}>
                                    Last
                                </button>
                            </div>
                        </div>
                    )}
                    <div className="result-status">
                        <span>{activeTab?.result ? resultSummary(activeTab.result, paginatedRows.length) : 'No query executed'}</span>
                        <span>{activeTab?.result ? `Duration: ${formatDuration(activeTab.result.durationMs)}` : 'Ready'}</span>
                    </div>
                </section>
                </>
                )}
            </main>

            {showHistory && (
            <aside className="history">
                <div className="panel-title">
                    <span>Recent Queries</span>
                    <button className="secondary small" onClick={() => setShowHistory(false)}>Close</button>
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
            )}
            {pendingUpdateBatch && (
                <div className="modal-backdrop" role="presentation">
                    <div className="update-confirm-dialog" role="dialog" aria-modal="true" aria-label="Confirm update query">
                        <div className="panel-title">
                            <span>Run Update Queries?</span>
                        </div>
                        <p>
                            Apply <strong>{pendingUpdateBatch.edits.length}</strong> pending edit{pendingUpdateBatch.edits.length === 1 ? '' : 's'}.
                        </p>
                        <div className="update-query-preview">
                            <button
                                type="button"
                                className="copy-cell-button"
                                onClick={() => copyText(pendingUpdateBatch.sql, 'Copied update query')}
                                title="Copy update query"
                                aria-label="Copy update query"
                            >
                                ⧉
                            </button>
                            <pre>{pendingUpdateBatch.sql}</pre>
                        </div>
                        <div className="button-row two">
                            <button className="secondary" onClick={() => setPendingUpdateBatch(null)} disabled={isRunning}>Cancel</button>
                            <button onClick={runPendingUpdateBatch} disabled={isRunning}>Run update queries</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}

const ResultGrid = memo(function ResultGrid({columns, rows, rowOffset = 0, showFilters, columnFilters, onFilterChange, onFilterClear, onCopyText, sort, onSort, canEdit, edits, primaryKeyNames, onCellUpdate}) {
    const handleCellCopy = useCallback((event) => {
        const target = event.target.closest?.('.copy-cell-icon');
        if (!target) {
            return;
        }
        const rowIndex = Number(target.dataset.rowIndex);
        const columnIndex = Number(target.dataset.columnIndex);
        const column = columns[columnIndex];
        if (!column || !rows[rowIndex]) {
            return;
        }
        onCopyText(copyValue(rows[rowIndex][column.name]), `Copied ${column.name} value`);
    }, [columns, rows, onCopyText]);

    const handleCellEditKeyDown = useCallback((event) => {
        if (!canEdit) {
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            event.currentTarget.textContent = event.currentTarget.dataset.originalValue || '';
            event.currentTarget.blur();
            return;
        }
        if (event.key !== 'Enter') {
            return;
        }
        event.preventDefault();
        const rowIndex = Number(event.currentTarget.dataset.rowIndex);
        const columnIndex = Number(event.currentTarget.dataset.columnIndex);
        const row = rows[rowIndex];
        const column = columns[columnIndex];
        if (!row || !column) {
            return;
        }
        const nextValue = event.currentTarget.textContent || '';
        if (nextValue === (event.currentTarget.dataset.originalValue || '')) {
            event.currentTarget.blur();
            return;
        }
        event.currentTarget.blur();
        onCellUpdate(row, column, nextValue);
    }, [canEdit, columns, rows, onCellUpdate]);

    if (!columns.length) {
        return <div className="empty-state">Run a query to see results.</div>
    }

    return (
        <div className="table-wrap">
            <table className="result-table">
                <thead>
                    <tr>
                        <th className="row-number-cell">#</th>
                        {columns.map((column) => (
                            <th key={column.name}>
                                <div className="result-column-header">
                                    <span title={column.name}>{column.name}</span>
                                    <div className="result-column-actions">
                                        <button
                                            type="button"
                                            className={sort?.column === column.name ? `sort-button active ${sort.direction}` : 'sort-button'}
                                            onClick={() => onSort(column.name)}
                                            title={`Sort by ${column.name}`}
                                        >
                                            {sort?.column === column.name && sort.direction === 'desc' ? '↓' : '↑'}
                                        </button>
                                        <button
                                            type="button"
                                            className="copy-cell-button"
                                            onClick={() => onCopyText(
                                                rows.map((row) => escapeCsvValue(row[column.name])).join(','),
                                                `Copied ${rows.length} visible values from ${column.name}`,
                                            )}
                                            title={`Copy visible ${column.name} values as comma-separated text`}
                                        >
                                            ⧉
                                        </button>
                                    </div>
                                </div>
                            </th>
                        ))}
                    </tr>
                    {showFilters && (
                        <tr className="column-filter-row">
                            <th className="row-number-cell"></th>
                            {columns.map((column) => (
                                <th key={`${column.name}-filter`}>
                                    <div className={filterInputClass(column)}>
                                        {isDateColumn(column) ? (
                                            <>
                                            <select
                                                value={dateFilterSelectValue(columnFilters[column.name])}
                                                onChange={(event) => onFilterChange(
                                                    column.name,
                                                    isDateCompareOperator(event.target.value)
                                                        ? buildDateOperatorFilterValue(columnFilters[column.name], event.target.value)
                                                        : event.target.value,
                                                )}
                                                title={`Filter ${column.name}`}
                                            >
                                                <option value="">Any date</option>
                                                {specialFilterOptions()}
                                                <option value="date:today">Today</option>
                                                <option value="date:yesterday">Yesterday</option>
                                                <option value="date:last3">Last 3 days</option>
                                                <option value="date:last7">Last 7 days</option>
                                                <option value="date:last30">Last 30 days</option>
                                                <option value="eq">=</option>
                                                <option value="neq">!=</option>
                                                <option value="gt">&gt;</option>
                                                <option value="gte">&gt;=</option>
                                                <option value="lt">&lt;</option>
                                                <option value="lte">&lt;=</option>
                                                <option value="between">Between</option>
                                            </select>
                                            <input
                                                type="date"
                                                value={customDatePart(columnFilters[column.name], 'start')}
                                                disabled={!dateFilterNeedsCustomValue(columnFilters[column.name])}
                                                onDoubleClick={(event) => {
                                                    onFilterChange(
                                                        column.name,
                                                        buildDateTimeFilterValue(columnFilters[column.name], '', '', 'start'),
                                                    );
                                                    event.currentTarget.blur();
                                                }}
                                                onChange={(event) => {
                                                    onFilterChange(
                                                        column.name,
                                                        buildDateTimeFilterValue(
                                                            columnFilters[column.name],
                                                            event.target.value,
                                                            customTimePart(columnFilters[column.name], 'start'),
                                                            'start',
                                                        ),
                                                    );
                                                    event.currentTarget.blur();
                                                }}
                                                title={`Date for ${column.name}`}
                                            />
                                            <input
                                                type="time"
                                                value={customTimePart(columnFilters[column.name], 'start')}
                                                disabled={!dateFilterNeedsCustomValue(columnFilters[column.name]) || !customDatePart(columnFilters[column.name], 'start')}
                                                onChange={(event) => onFilterChange(
                                                    column.name,
                                                    buildDateTimeFilterValue(
                                                        columnFilters[column.name],
                                                        customDatePart(columnFilters[column.name], 'start'),
                                                        event.target.value,
                                                        'start',
                                                    ),
                                                )}
                                                title={`Optional time for ${column.name}`}
                                            />
                                            {dateCompareOperatorValue(columnFilters[column.name]) === 'between' && (
                                                <>
                                                <input
                                                    type="date"
                                                    value={customDatePart(columnFilters[column.name], 'end')}
                                                    disabled={!dateFilterNeedsCustomValue(columnFilters[column.name])}
                                                    onDoubleClick={(event) => {
                                                        onFilterChange(
                                                            column.name,
                                                            buildDateTimeFilterValue(columnFilters[column.name], '', '', 'end'),
                                                        );
                                                        event.currentTarget.blur();
                                                    }}
                                                    onChange={(event) => {
                                                        onFilterChange(
                                                            column.name,
                                                            buildDateTimeFilterValue(
                                                                columnFilters[column.name],
                                                                event.target.value,
                                                                customTimePart(columnFilters[column.name], 'end'),
                                                                'end',
                                                            ),
                                                        );
                                                        event.currentTarget.blur();
                                                    }}
                                                    title={`End date for ${column.name}`}
                                                />
                                                <input
                                                    type="time"
                                                    value={customTimePart(columnFilters[column.name], 'end')}
                                                    disabled={!customDatePart(columnFilters[column.name], 'end')}
                                                    onChange={(event) => onFilterChange(
                                                        column.name,
                                                        buildDateTimeFilterValue(
                                                            columnFilters[column.name],
                                                            customDatePart(columnFilters[column.name], 'end'),
                                                            event.target.value,
                                                            'end',
                                                        ),
                                                    )}
                                                    title={`Optional end time for ${column.name}`}
                                                />
                                                </>
                                            )}
                                            </>
                                        ) : isNumericColumn(column) ? (
                                            <>
                                            <select
                                                value={numericOperatorValue(columnFilters[column.name])}
                                                onChange={(event) => onFilterChange(
                                                    column.name,
                                                    isSpecialFilter(event.target.value) || event.target.value === '' ? event.target.value : `num:${event.target.value}:`,
                                                )}
                                                title={`Compare ${column.name}`}
                                            >
                                                <option value="">Any number</option>
                                                {specialFilterOptions()}
                                                <option value="eq">=</option>
                                                <option value="neq">!=</option>
                                                <option value="gt">&gt;</option>
                                                <option value="gte">&gt;=</option>
                                                <option value="lt">&lt;</option>
                                                <option value="lte">&lt;=</option>
                                            </select>
                                            <input
                                                type="number"
                                                value={numericFilterValue(columnFilters[column.name])}
                                                disabled={!numericOperatorValue(columnFilters[column.name]) || isSpecialFilter(columnFilters[column.name])}
                                                placeholder="Value"
                                                onChange={(event) => onFilterChange(column.name, `num:${numericOperatorValue(columnFilters[column.name]) || 'eq'}:${event.target.value}`)}
                                            />
                                            </>
                                        ) : (
                                            <>
                                            <input
                                                value={columnFilters[column.name] || ''}
                                                list={`filter-options-${column.name}`}
                                                placeholder={`Filter ${column.name}`}
                                                onChange={(event) => onFilterChange(column.name, event.target.value)}
                                            />
                                            <datalist id={`filter-options-${column.name}`}>
                                                <option value="NULL" />
                                                <option value="NOT NULL" />
                                                <option value="Empty" />
                                                <option value="Not empty" />
                                            </datalist>
                                            </>
                                        )}
                                        {(columnFilters[column.name] || '') && (
                                            <button type="button" onClick={() => onFilterClear(column.name)} title={`Clear ${column.name} filter`}>
                                                ×
                                            </button>
                                        )}
                                    </div>
                                </th>
                            ))}
                        </tr>
                    )}
                </thead>
                <tbody onClick={handleCellCopy}>
                    {rows.map((row, rowIndex) => (
                        <tr key={rowIndex}>
                            <td className="row-number-cell">{rowOffset + rowIndex + 1}</td>
                            {columns.map((column, columnIndex) => (
                                <td key={column.name}>
                                    {(() => {
                                        const rowKey = getRowKey(row, primaryKeyNames);
                                        const editKey = rowKey ? makeResultEditKey(rowKey.name, rowKey.value, column.name) : '';
                                        const edit = edits?.[editKey];
                                        const displayValue = edit ? edit.nextValue : formatValue(row[column.name]);
                                        const editable = canEdit && rowKey && !isPrimaryKeyColumn(column, primaryKeyNames);
                                        return (
                                    <div className="result-cell-content">
                                        <span
                                            key={`${editKey}:${displayValue}`}
                                            className={editable ? (edit ? 'result-cell-value editable edited' : 'result-cell-value editable') : 'result-cell-value'}
                                            contentEditable={editable}
                                            suppressContentEditableWarning
                                            data-row-index={rowIndex}
                                            data-column-index={columnIndex}
                                            data-original-value={formatValue(row[column.name])}
                                            title={editable ? 'Edit value and press Enter to stage this update' : formatValue(row[column.name])}
                                            onKeyDown={handleCellEditKeyDown}
                                        >
                                            {displayValue}
                                        </span>
                                        <span
                                            className="copy-cell-button copy-cell-icon"
                                            data-row-index={rowIndex}
                                            data-column-index={columnIndex}
                                            title={`Copy ${column.name} value`}
                                            role="button"
                                            aria-label={`Copy ${column.name} value`}
                                        >
                                            ⧉
                                        </span>
                                    </div>
                                        );
                                    })()}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
});

function getExecutableSql(editor, fullSql) {
    if (!editor) {
        return fullSql.trim();
    }

    const model = editor.getModel?.();
    const selection = editor.getSelection?.();
    if (model && selection && !selection.isEmpty()) {
        const selectedSql = model.getValueInRange(selection).trim();
        if (selectedSql) {
            return stripTrailingSemicolon(selectedSql);
        }
    }

    const position = editor.getPosition?.();
    if (!model || !position) {
        return fullSql.trim();
    }

    const cursorOffset = model.getOffsetAt(position);
    const statements = parseSqlStatements(fullSql);
    if (statements.length === 0) {
        return '';
    }

    const containing = statements.find((statement) =>
        cursorOffset >= statement.start && cursorOffset <= statement.delimiterEnd,
    );
    if (containing) {
        return containing.sql;
    }

    for (let index = 0; index < statements.length; index += 1) {
        const current = statements[index];
        const next = statements[index + 1];
        if (next && cursorOffset > current.delimiterEnd && cursorOffset < next.start) {
            return current.sql;
        }
        if (cursorOffset < current.start) {
            return current.sql;
        }
    }

    return statements[statements.length - 1].sql;
}

function parseSqlStatements(sql) {
    const statements = [];
    let quote = '';
    let statementStart = 0;

    for (let index = 0; index < sql.length; index += 1) {
        const char = sql[index];
        if (quote) {
            if (char === quote && sql[index - 1] !== '\\') {
                quote = '';
            }
            continue;
        }
        if (char === '"' || char === '\'' || char === '`') {
            quote = char;
            continue;
        }
        if (char === ';') {
            addStatementRange(statements, sql, statementStart, index, index + 1);
            statementStart = index + 1;
        }
    }

    addStatementRange(statements, sql, statementStart, sql.length, sql.length);
    return statements;
}

function addStatementRange(statements, sql, rawStart, rawEnd, delimiterEnd) {
    let start = rawStart;
    let end = rawEnd;
    while (start < end && /\s/.test(sql[start])) {
        start += 1;
    }
    while (end > start && /\s/.test(sql[end - 1])) {
        end -= 1;
    }
    const statementSql = stripTrailingSemicolon(sql.slice(start, end).trim());
    if (!statementSql) {
        return;
    }
    statements.push({
        start,
        end,
        delimiterEnd,
        sql: statementSql,
    });
}

function buildExplainSql(sql) {
    const trimmed = stripTrailingSemicolon(sql);
    if (/^explain\b/i.test(trimmed)) {
        return trimmed;
    }
    return `EXPLAIN ${trimmed}`;
}

function inferEditableTableName(sql) {
    const statement = stripTrailingSemicolon(stripSqlComments(sql)).trim();
    if (!/^select\b/i.test(statement) || /\bjoin\b/i.test(statement)) {
        return '';
    }
    const match = statement.match(/\bfrom\s+((?:`[^`]+`|[A-Za-z0-9_$]+)(?:\s*\.\s*(?:`[^`]+`|[A-Za-z0-9_$]+))?)(?:\s+(?:as\s+)?(?:`[^`]+`|[A-Za-z0-9_$]+))?\s*(?:where\b|group\b|order\b|having\b|limit\b|$)/i);
    if (!match) {
        return '';
    }
    const fromMatch = statement.match(/\bfrom\b/i);
    if (!fromMatch) {
        return '';
    }
    const fromTail = statement.slice(fromMatch.index + fromMatch[0].length);
    const beforeClause = fromTail.split(/\bwhere\b|\bgroup\b|\border\b|\bhaving\b|\blimit\b/i)[0];
    if (beforeClause.includes(',')) {
        return '';
    }
    return unquoteIdentifierPath(match[1]);
}

function stripSqlComments(sql) {
    return String(sql || '')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/--[^\n\r]*/g, ' ')
        .replace(/#[^\n\r]*/g, ' ');
}

function unquoteIdentifierPath(identifier) {
    return String(identifier || '')
        .split('.')
        .map((part) => part.trim().replace(/^`|`$/g, '').replace(/``/g, '`'))
        .filter(Boolean)
        .join('.');
}

function quoteIdentifierPath(identifier) {
    return String(identifier || '')
        .split('.')
        .map((part) => quoteIdentifier(part.trim().replace(/^`|`$/g, '')))
        .join('.');
}

function buildUpdateSql(tableName, column, rawValue, rowKey) {
    const valueSql = formatEditedValueForSql(rawValue, column);
    const keySql = formatIdValueForSql(rowKey?.value);
    if (!tableName || !column?.name || !rowKey?.name || valueSql === null || keySql === null) {
        return '';
    }
    return `UPDATE ${quoteIdentifierPath(tableName)} SET ${quoteIdentifier(column.name)} = ${valueSql} WHERE ${quoteIdentifier(rowKey.name)} = ${keySql}`;
}

function formatEditedValueForSql(rawValue, column) {
    const text = String(rawValue ?? '').trim();
    if (/^null$/i.test(text)) {
        return 'NULL';
    }
    if (isNumericColumn(column)) {
        return /^-?\d+(\.\d+)?$/.test(text) ? text : null;
    }
    return `'${escapeSqlString(String(rawValue ?? ''))}'`;
}

function formatIdValueForSql(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    const text = String(value);
    return /^-?\d+(\.\d+)?$/.test(text) ? text : `'${escapeSqlString(text)}'`;
}

function escapeSqlString(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/'/g, "''");
}

function getRowKey(row, primaryKeyNames = new Set()) {
    const keys = Object.keys(row || {});
    const schemaKey = keys.find((item) => primaryKeyNames.has(item.toLowerCase()));
    const fallbackKey = keys.find((item) => item.toLowerCase() === 'id');
    const key = schemaKey || fallbackKey;
    if (!key) {
        return null;
    }
    const value = row[key];
    if (value === null || value === undefined || value === '') {
        return null;
    }
    return {name: key, value};
}

function makeResultEditKey(keyName, keyValue, columnName) {
    return `${String(keyName)}\u0000${String(keyValue)}\u0000${String(columnName)}`;
}

function formatSql(sql) {
    return sql
        .replace(/\s+/g, ' ')
        .replace(/\s*,\s*/g, ',\n    ')
        .replace(/\s+(FROM|WHERE|GROUP BY|ORDER BY|HAVING|LIMIT|VALUES|SET)\b/gi, '\n$1')
        .replace(/\s+(INNER JOIN|LEFT JOIN|RIGHT JOIN|JOIN)\b/gi, '\n$1')
        .replace(/\s+(AND|OR)\s+/gi, '\n  $1 ')
        .replace(/\b(SELECT|FROM|WHERE|GROUP BY|ORDER BY|HAVING|LIMIT|INSERT INTO|UPDATE|DELETE FROM|VALUES|SET|INNER JOIN|LEFT JOIN|RIGHT JOIN|JOIN|ON|AND|OR|AS|EXPLAIN)\b/gi, (keyword) => keyword.toUpperCase())
        .split('\n')
        .map((line) => line.trimEnd())
        .join('\n')
        .trim();
}

function sanitizeFileName(name) {
    return String(name || 'query')
        .trim()
        .replace(/[^a-z0-9_-]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        || 'query';
}

function resultToCsv(columns, rows) {
    const columnNames = columns.map((column) => column.name);
    const lines = [
        columnNames.map(escapeCsvValue).join(','),
        ...rows.map((row) => columnNames.map((column) => escapeCsvValue(row[column])).join(',')),
    ];
    return lines.join('\n') + '\n';
}

function escapeCsvValue(value) {
    if (value === null || value === undefined) {
        return '';
    }
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (/[",\n\r]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
}

function copyValue(value) {
    if (value === null || value === undefined) {
        return '';
    }
    if (typeof value === 'object') {
        return JSON.stringify(value);
    }
    return String(value);
}

function compareSortValues(left, right) {
    if (left === null || left === undefined) {
        return right === null || right === undefined ? 0 : -1;
    }
    if (right === null || right === undefined) {
        return 1;
    }

    const leftNumber = Number(left);
    const rightNumber = Number(right);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
        return leftNumber - rightNumber;
    }

    const leftDate = Date.parse(left);
    const rightDate = Date.parse(right);
    if (Number.isFinite(leftDate) && Number.isFinite(rightDate)) {
        return leftDate - rightDate;
    }

    return String(left).localeCompare(String(right), undefined, {numeric: true, sensitivity: 'base'});
}

function downloadTextFile(filename, content, type) {
    const blob = new Blob([content], {type});
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
}

function stripTrailingSemicolon(sql) {
    return sql.replace(/;\s*$/, '').trim();
}

function specialFilterOptions() {
    return (
        <>
            <option value="NULL">NULL</option>
            <option value="NOT NULL">NOT NULL</option>
            <option value="Empty">Empty</option>
            <option value="Not empty">Not empty</option>
        </>
    );
}

function resultSummary(result, visibleRows) {
    return `${visibleRows} shown | ${rowResultLabel(result)} | ${result.success ? 'Success' : 'Failed'}`;
}

function rowResultLabel(result) {
    const returned = Array.isArray(result.rows) ? result.rows.length : 0;
    if ((result.columns || []).length > 0) {
        return `${returned} row${returned === 1 ? '' : 's'} returned`;
    }
    return `${result.rowsAffected || 0} row${result.rowsAffected === 1 ? '' : 's'} affected`;
}

function formatDuration(durationMs) {
    if (durationMs === null || durationMs === undefined) {
        return '0 ms';
    }
    if (durationMs < 1000) {
        return `${durationMs} ms`;
    }
    return `${(durationMs / 1000).toFixed(2)} s`;
}

function isDateColumn(column) {
    const type = String(column?.type || column?.dataType || column?.columnType || '').toLowerCase();
    return ['date', 'time', 'timestamp', 'datetime', 'year'].some((item) => type.includes(item));
}

function isNumericColumn(column) {
    const type = String(column?.type || column?.dataType || column?.columnType || '').toLowerCase();
    return ['int', 'decimal', 'numeric', 'float', 'double', 'real', 'bit'].some((item) => type.includes(item));
}

function filterInputClass(column) {
    if (isDateColumn(column)) {
        return 'column-filter-input date-filter';
    }
    if (isNumericColumn(column)) {
        return 'column-filter-input number-filter';
    }
    return 'column-filter-input';
}

function sortColumnsByName(columns = [], primaryKeyNames = new Set()) {
    return [...columns].sort((left, right) =>
        Number(isPrimaryKeyColumn(right, primaryKeyNames)) - Number(isPrimaryKeyColumn(left, primaryKeyNames))
        || String(left?.name || '').localeCompare(String(right?.name || ''), undefined, {
            numeric: true,
            sensitivity: 'base',
        }),
    );
}

function isPrimaryKeyColumn(column, primaryKeyNames = new Set()) {
    const columnName = String(column?.name || '').toLowerCase();
    return String(column?.key || '').toUpperCase() === 'PRI' || primaryKeyNames.has(columnName) || columnName === 'id';
}

function primaryKeyNamesForTable(schema, tableName) {
    const normalizedTableName = lastIdentifierPart(tableName).toLowerCase();
    if (!normalizedTableName) {
        return new Set();
    }
    const table = (schema?.tables || []).find((item) =>
        lastIdentifierPart(item.name).toLowerCase() === normalizedTableName,
    );
    return new Set(
        (table?.columns || [])
            .filter((column) => String(column.key || '').toUpperCase() === 'PRI')
            .map((column) => String(column.name || '').toLowerCase()),
    );
}

function lastIdentifierPart(identifier = '') {
    const parts = String(identifier).split('.').map((part) => part.trim()).filter(Boolean);
    return parts[parts.length - 1] || '';
}

function matchesDatePreset(value, preset) {
    const date = parseResultDate(value);
    if (!date) {
        return false;
    }

    const valueDay = startOfDay(date).getTime();
    const today = startOfDay(new Date());

    if (preset.startsWith('date:custom:')) {
        const selectedDate = parseResultDate(preset.replace('date:custom:', ''));
        return selectedDate ? valueDay === startOfDay(selectedDate).getTime() : false;
    }

    if (preset === 'date:today') {
        return valueDay === today.getTime();
    }
    if (preset === 'date:yesterday') {
        const yesterday = addDays(today, -1).getTime();
        return valueDay === yesterday;
    }

    const days = {
        'date:last3': 3,
        'date:last7': 7,
        'date:last30': 30,
    }[preset];
    if (!days) {
        return false;
    }

    const earliest = addDays(today, -(days - 1)).getTime();
    return valueDay >= earliest && valueDay <= today.getTime();
}

function matchesDateComparison(value, filter) {
    const [, operator, ...rawDateParts] = filter.split(':');
    const rawDate = rawDateParts.join(':');
    if (!rawDate) {
        return true;
    }
    const actualDate = parseResultDate(value);
    if (!actualDate) {
        return false;
    }

    if (operator === 'between') {
        const [rawStart, rawEnd] = rawDate.split('|');
        const startDate = rawStart ? parseResultDate(rawStart) : null;
        const endDate = rawEnd ? parseResultDate(rawEnd) : null;
        if (!startDate && !endDate) {
            return true;
        }
        const compareWithTime = hasTimeComponent(rawStart) || hasTimeComponent(rawEnd);
        const actual = compareWithTime ? actualDate.getTime() : startOfDay(actualDate).getTime();
        const start = startDate ? (compareWithTime ? startDate.getTime() : startOfDay(startDate).getTime()) : null;
        const end = endDate ? (compareWithTime ? endDate.getTime() : startOfDay(endDate).getTime()) : null;
        return (start === null || actual >= start) && (end === null || actual <= end);
    }

    const expectedDate = parseResultDate(rawDate);
    if (!expectedDate) {
        return false;
    }

    const actual = hasTimeComponent(rawDate) ? actualDate.getTime() : startOfDay(actualDate).getTime();
    const expected = hasTimeComponent(rawDate) ? expectedDate.getTime() : startOfDay(expectedDate).getTime();

    switch (operator) {
        case 'eq':
            return actual === expected;
        case 'neq':
            return actual !== expected;
        case 'gt':
            return actual > expected;
        case 'gte':
            return actual >= expected;
        case 'lt':
            return actual < expected;
        case 'lte':
            return actual <= expected;
        default:
            return true;
    }
}

function dateFilterSelectValue(value = '') {
    if (value.startsWith('datecmp:')) {
        return value.split(':')[1] || '';
    }
    return value;
}

function dateCompareOperatorValue(value = '') {
    return value.startsWith('datecmp:') ? value.split(':')[1] || '' : '';
}

function dateFilterNeedsCustomValue(value = '') {
    return value.startsWith('datecmp:');
}

function hasTimeComponent(value = '') {
    return /[T ]\d{2}:\d{2}/.test(value);
}

function isDateCompareOperator(value = '') {
    return ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between'].includes(value);
}

function matchesNumericFilter(value, filter) {
    const [, operator, rawExpected] = filter.split(':');
    if (rawExpected === undefined || rawExpected === '') {
        return true;
    }
    const actual = Number(value);
    const expected = Number(rawExpected);
    if (Number.isNaN(actual) || Number.isNaN(expected)) {
        return false;
    }

    switch (operator) {
        case 'eq':
            return actual === expected;
        case 'neq':
            return actual !== expected;
        case 'gt':
            return actual > expected;
        case 'gte':
            return actual >= expected;
        case 'lt':
            return actual < expected;
        case 'lte':
            return actual <= expected;
        default:
            return true;
    }
}

function numericOperatorValue(value = '') {
    if (isSpecialFilter(value)) {
        return value;
    }
    return value.startsWith('num:') ? value.split(':')[1] || '' : '';
}

function numericFilterValue(value = '') {
    return value.startsWith('num:') ? value.split(':').slice(2).join(':') : '';
}

function customDateValue(value = '', bound = 'start') {
    if (value.startsWith('datecmp:')) {
        const operator = dateCompareOperatorValue(value);
        const rawValue = value.split(':').slice(2).join(':');
        if (operator === 'between') {
            const [startValue = '', endValue = ''] = rawValue.split('|');
            return bound === 'end' ? endValue : startValue;
        }
        return rawValue;
    }
    return '';
}

function customDatePart(value = '', bound = 'start') {
    return customDateValue(value, bound).split('T')[0] || '';
}

function customTimePart(value = '', bound = 'start') {
    return customDateValue(value, bound).split('T')[1] || '';
}

function buildDateOperatorFilterValue(currentValue = '', nextOperator = '') {
    if (!nextOperator) {
        return '';
    }
    if (nextOperator === 'between') {
        const startValue = customDateValue(currentValue, 'start');
        const endValue = customDateValue(currentValue, 'end');
        return `datecmp:between:${startValue}|${endValue}`;
    }
    return `datecmp:${nextOperator}:${customDateValue(currentValue, 'start')}`;
}

function buildDateTimeFilterValue(currentValue = '', date = '', time = '', bound = 'start') {
    const operator = dateCompareOperatorValue(currentValue) || 'eq';
    const nextValue = date ? `${date}${time ? `T${time}` : ''}` : '';
    if (operator === 'between') {
        const startValue = bound === 'start' ? nextValue : customDateValue(currentValue, 'start');
        const endValue = bound === 'end' ? nextValue : customDateValue(currentValue, 'end');
        return `datecmp:${operator}:${startValue}|${endValue}`;
    }
    return `datecmp:${operator}:${nextValue}`;
}

function isSpecialFilter(value = '') {
    return ['NULL', 'NOT NULL', 'Empty', 'Not empty'].includes(value);
}

function matchesSpecialFilter(value, filter) {
    const isNull = value === null || value === undefined;
    const isEmpty = !isNull && String(value).trim() === '';

    switch (filter) {
        case 'NULL':
            return isNull;
        case 'NOT NULL':
            return !isNull;
        case 'Empty':
            return isEmpty;
        case 'Not empty':
            return !isNull && !isEmpty;
        default:
            return true;
    }
}

function parseResultDate(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, days) {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
}

function buildSuggestions(monaco, schema) {
    const suggestions = mysqlKeywords.map((keyword) => ({
        label: keyword,
        kind: monaco.languages.CompletionItemKind.Keyword,
        insertText: keyword,
    }));

    const seenTables = new Set();
    for (const table of schema?.tables || []) {
        if (!seenTables.has(table.name)) {
            seenTables.add(table.name);
            suggestions.push({
                label: table.name,
                kind: monaco.languages.CompletionItemKind.Struct,
                insertText: `${quoteIdentifier(table.name)} ${buildAlias(table.name)}`,
                detail: `table alias ${buildAlias(table.name)}`,
            });
        }

        for (const column of table.columns || []) {
            suggestions.push({
                label: column.name,
                kind: monaco.languages.CompletionItemKind.Field,
                insertText: column.name,
                detail: `${table.name}.${column.name} ${column.dataType}`,
            });
        }
    }

    return suggestions;
}

function formatValue(value) {
    if (value === null || value === undefined) {
        return 'NULL';
    }
    if (typeof value === 'object') {
        return JSON.stringify(value);
    }
    return String(value);
}

function formatRowCount(value) {
    if (value === null || value === undefined) {
        return '0';
    }
    return Number(value).toLocaleString();
}

function formatColumnMeta(column) {
    return [
        column.columnType || column.dataType || 'unknown',
        column.nullable ? 'NULL' : 'NOT NULL',
        column.key,
    ].filter(Boolean).join(' | ');
}

function columnIconClass(column) {
    if (column.key === 'PRI') {
        return 'column-icon key';
    }
    const type = (column.dataType || column.columnType || '').toLowerCase();
    if (['int', 'bigint', 'smallint', 'tinyint', 'decimal', 'float', 'double'].some((item) => type.includes(item))) {
        return 'column-icon number';
    }
    if (['date', 'time', 'year'].some((item) => type.includes(item))) {
        return 'column-icon date';
    }
    if (['char', 'text', 'enum', 'set'].some((item) => type.includes(item))) {
        return 'column-icon text';
    }
    return 'column-icon other';
}

function columnIconLabel(column) {
    if (column.key === 'PRI') {
        return '⌘';
    }
    const type = (column.dataType || column.columnType || '').toLowerCase();
    if (['int', 'bigint', 'smallint', 'tinyint', 'decimal', 'float', 'double'].some((item) => type.includes(item))) {
        return '#';
    }
    if (['date', 'time', 'year'].some((item) => type.includes(item))) {
        return '◴';
    }
    if (['char', 'text', 'enum', 'set'].some((item) => type.includes(item))) {
        return 'T';
    }
    return '□';
}

function quoteIdentifier(identifier) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
        return identifier;
    }
    return `\`${identifier.replaceAll('`', '``')}\``;
}

function buildAlias(name) {
    const words = name
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean);

    if (words.length === 0) {
        return 't';
    }
    if (words.length === 1) {
        return words[0].slice(0, 2).toLowerCase();
    }
    return words.map((word) => word[0].toLowerCase()).join('').slice(0, 4);
}

function errorMessage(error) {
    return error?.message || String(error);
}

export default App
