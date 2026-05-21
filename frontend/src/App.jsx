import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import Editor from '@monaco-editor/react';
import './App.css';
import ResultGrid from './components/ResultGrid';
import {createQueryTab, DEFAULT_RESULT_PAGE_SIZE, normalizeWorkspace} from './constants/query';
import {
    columnIconClass,
    columnIconLabel,
    compareSortValues,
    errorMessage,
    formatColumnMeta,
    formatDuration,
    formatRowCount,
    formatValue,
    isDateColumn,
    isNumericColumn,
    isPrimaryKeyColumn,
    isSpecialFilter,
    matchesDateComparison,
    matchesDatePreset,
    matchesNumericFilter,
    matchesSpecialFilter,
    primaryKeyNamesForTable,
    resultSummary,
    resultToCsv,
    sanitizeFileName,
    sortColumnsByName,
} from './utils/results';
import {
    buildAlias,
    buildExplainSql,
    buildSuggestions,
    completionContext,
    formatSql,
    getExecutableSql,
    quoteIdentifier,
} from './utils/sql';
import {
    buildUpdateSql,
    getRowKey,
    inferEditableTableName,
    makeResultEditKey,
    validateEditedValue,
} from './utils/resultEdits';
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
    const [resultEditError, setResultEditError] = useState('');
    const [resultEditSuccess, setResultEditSuccess] = useState('');
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
            const message = selectedProfile?.readOnly ? 'Read-only connections cannot edit result rows' : 'Run a simple SELECT from one table to edit results';
            setResultEditError(message);
            setStatus(message);
            return;
        }
        if (isPrimaryKeyColumn(column, resultPrimaryKeyNames)) {
            const message = 'Primary key columns cannot be edited';
            setResultEditError(message);
            setStatus(message);
            return;
        }
        const rowKey = getRowKey(row, resultPrimaryKeyNames);
        if (!rowKey) {
            const message = 'Cannot update this row because the primary key is not in the result';
            setResultEditError(message);
            setStatus(message);
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
                setResultEditError('');
                setResultEditSuccess('');
                return next;
            });
            return;
        }
        const validationError = validateEditedValue(nextValue, column);
        if (validationError) {
            setResultEditError(validationError);
            setStatus(validationError);
            return;
        }
        const updateSql = buildUpdateSql(editableTableName, column, nextValue, rowKey);
        if (!updateSql) {
            const message = 'Could not build update query for this value';
            setResultEditError(message);
            setStatus(message);
            return;
        }
        setResultEditError('');
        setResultEditSuccess('');
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
        setResultEditError('');
        setResultEditSuccess('');
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
        setResultEditError('');
        setResultEditSuccess('');
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
                    const message = result.error || `Update failed for ${edit.columnName}`;
                    setPendingUpdateBatch(null);
                    setResultEditError(message);
                    setStatus(message);
                    return;
                }
                updatedRows += result.rowsAffected || 0;
            }
            const editCount = pendingUpdateBatch.edits.length;
            const message = `Applied ${editCount} edit${editCount === 1 ? '' : 's'} across ${updatedRows} row update${updatedRows === 1 ? '' : 's'}`;
            setPendingUpdateBatch(null);
            setResultEdits({});
            await executeCurrentSql('run');
            setResultEditSuccess(message);
            setStatus(message);
        } catch (error) {
            const message = errorMessage(error);
            setPendingUpdateBatch(null);
            setResultEditError(message);
            setStatus(message);
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
        const tab = activeTab;
        const columns = sortedResultColumns;
        const rows = filteredRows;

        if (!tab) {
            return;
        }
        if (!tab.result?.success || !columns.length) {
            setStatus('No query results to export');
            return;
        }

        setIsRunning(true);
        setStatus('Exporting current results to CSV...');
        try {
            const path = await SaveCSVFile(
                `${sanitizeFileName(tab.title || 'query-results')}.csv`,
                resultToCsv(columns, rows),
            );
            if (!path) {
                setStatus('Export cancelled');
                return;
            }
            setStatus(`Exported ${rows.length} row${rows.length === 1 ? '' : 's'} to ${path}`);
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
            triggerCharacters: ['.'],
            provideCompletionItems: (model, position) => ({
                suggestions: buildSuggestions(monaco, schemaRef.current, completionContext(model, position)),
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
                            snippetSuggestions: 'none',
                            wordBasedSuggestions: 'off',
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
                                className="filter-toggle export-button"
                                disabled={isRunning || !activeTab?.result?.success || !activeTab?.result?.columns?.length}
                                onClick={exportCsv}
                                title="Export current loaded results to CSV"
                            >
                                <svg className="download-icon" viewBox="0 0 16 16" aria-hidden="true">
                                    <path d="M8 2v7m0 0 3-3m-3 3L5 6" />
                                    <path d="M3 11v2h10v-2" />
                                </svg>
                                Export
                            </button>
                        </div>
                    </div>
                    {activeTab?.result?.error && <div className="error-box">{activeTab.result.error}</div>}
                    {resultEditError && <div className="error-box">{resultEditError}</div>}
                    {resultEditSuccess && <div className="success-box">{resultEditSuccess}</div>}
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


export default App
