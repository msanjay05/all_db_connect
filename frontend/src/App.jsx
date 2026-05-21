import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import Editor from '@monaco-editor/react';
import './App.css';
import HistoryPanel from './components/HistoryPanel';
import QueryToolbar from './components/QueryToolbar';
import ResultsPanel from './components/ResultsPanel';
import Sidebar from './components/Sidebar';
import UpdateConfirmDialog from './components/UpdateConfirmDialog';
import {createQueryTab, DEFAULT_RESULT_PAGE_SIZE, normalizeWorkspace} from './constants/query';
import {
    compareSortValues,
    errorMessage,
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
const EDITOR_WORKSPACE_STORAGE_KEY = 'all-db-connector.editor-workspaces.v1';
const persistedEditorState = loadPersistedEditorState();
const initialEditorWorkspace = persistedEditorState.activeConnectionId
    ? normalizeWorkspace(persistedEditorState.workspaces[persistedEditorState.activeConnectionId])
    : normalizeWorkspace();

function App() {
    const [profiles, setProfiles] = useState([]);
    const [selectedConnectionId, setSelectedConnectionId] = useState(persistedEditorState.activeConnectionId);
    const [profileForm, setProfileForm] = useState(defaultProfile);
    const [showConnectionForm, setShowConnectionForm] = useState(false);
    const [connectionTestStatus, setConnectionTestStatus] = useState('');
    const [databases, setDatabases] = useState([]);
    const [selectedDatabase, setSelectedDatabase] = useState('');
    const [schema, setSchema] = useState({database: '', tables: []});
    const [queryTabs, setQueryTabs] = useState(() => initialEditorWorkspace.queryTabs);
    const [activeTabId, setActiveTabId] = useState(initialEditorWorkspace.activeTabId);
    const [connectionWorkspaces, setConnectionWorkspaces] = useState(persistedEditorState.workspaces);
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
    const restoredInitialConnectionRef = useRef(false);

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
    const connectionOptions = useMemo(
        () => profiles.map((profile) => ({
            value: profile.id,
            label: profile.name,
            title: profile.host,
        })),
        [profiles],
    );
    const databaseOptions = useMemo(
        () => databases.map((database) => ({
            value: database,
            label: database,
        })),
        [databases],
    );

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
        persistEditorState(selectedConnectionId, connectionWorkspaces);
    }, [selectedConnectionId, connectionWorkspaces]);

    useEffect(() => {
        function persistBeforeUnload() {
            const currentConnectionId = selectedConnectionIdRef.current;
            if (!currentConnectionId) {
                persistEditorState('', connectionWorkspacesRef.current);
                return;
            }
            const nextWorkspaces = {
                ...connectionWorkspacesRef.current,
                [currentConnectionId]: currentWorkspaceSnapshot(),
            };
            persistEditorState(currentConnectionId, nextWorkspaces);
        }

        window.addEventListener('beforeunload', persistBeforeUnload);
        return () => {
            persistBeforeUnload();
            window.removeEventListener('beforeunload', persistBeforeUnload);
        };
    }, []);

    useEffect(() => {
        setResultEdits({});
        setPendingUpdateBatch(null);
    }, [activeTabId, selectedConnectionId, selectedDatabase]);

    useEffect(() => {
        if (!selectedConnectionId) {
            return;
        }
        const workspace = normalizeWorkspace({queryTabs, activeTabId});
        setConnectionWorkspaces((current) => {
            const next = {
                ...current,
                [selectedConnectionId]: workspace,
            };
            connectionWorkspacesRef.current = next;
            return next;
        });
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

    function saveWorkspaceForConnection(connectionId, workspace) {
        if (!connectionId) {
            return;
        }
        const normalized = normalizeWorkspace(workspace);
        connectionWorkspacesRef.current = {
            ...connectionWorkspacesRef.current,
            [connectionId]: normalized,
        };
        setConnectionWorkspaces(connectionWorkspacesRef.current);
    }

    function currentWorkspaceSnapshot() {
        const tabs = queryTabsRef.current.length ? queryTabsRef.current : [createQueryTab(1)];
        const activeId = activeTabIdRef.current || tabs[0].id;
        const editorSql = editorRef.current?.getValue?.();
        const snapshotTabs = tabs.map((tab) =>
            tab.id === activeId && editorSql !== undefined ? {...tab, sql: editorSql} : tab,
        );
        return normalizeWorkspace({queryTabs: snapshotTabs, activeTabId: activeId});
    }

    function workspaceForConnection(connectionId) {
        return normalizeWorkspace(connectionWorkspacesRef.current[connectionId]);
    }

    function applyWorkspace(workspace) {
        const normalized = normalizeWorkspace(workspace);
        editorRef.current = null;
        setQueryTabs(normalized.queryTabs);
        setActiveTabId(normalized.activeTabId);
        setResultEdits({});
        setResultEditError('');
        setResultEditSuccess('');
        setPendingUpdateBatch(null);
    }

    function restoreConnectionWorkspace(connectionId) {
        const workspace = workspaceForConnection(connectionId);
        applyWorkspace(workspace);
    }

    function switchConnectionWorkspace(nextConnectionId) {
        const currentConnectionId = selectedConnectionIdRef.current;
        if (currentConnectionId && currentConnectionId !== nextConnectionId) {
            saveWorkspaceForConnection(currentConnectionId, currentWorkspaceSnapshot());
        }
        if (nextConnectionId) {
            restoreConnectionWorkspace(nextConnectionId);
        } else {
            applyWorkspace({queryTabs: [createQueryTab(1)], activeTabId: 1});
        }
    }

    function removeWorkspaceForConnection(connectionId) {
        if (!connectionId) {
            return;
        }
        const nextWorkspaces = {...connectionWorkspacesRef.current};
        delete nextWorkspaces[connectionId];
        connectionWorkspacesRef.current = nextWorkspaces;
        setConnectionWorkspaces(nextWorkspaces);
    }

    function resetConnectionData() {
        setDatabases([]);
        setSelectedDatabase('');
        setSchema({database: '', tables: []});
    }

    async function refreshProfiles() {
        try {
            const items = await ListConnectionProfiles();
            setProfiles(items || []);
            const activeConnectionId = selectedConnectionIdRef.current;
            if (!restoredInitialConnectionRef.current && activeConnectionId) {
                restoredInitialConnectionRef.current = true;
                const activeProfile = (items || []).find((profile) => profile.id === activeConnectionId);
                if (activeProfile) {
                    loadDatabases(activeConnectionId, activeProfile.database);
                } else {
                    setSelectedConnectionId('');
                    resetConnectionData();
                    applyWorkspace({queryTabs: [createQueryTab(1)], activeTabId: 1});
                }
            }
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
        if (!connectionID) {
            disconnectProfile();
            return;
        }
        const profile = profiles.find((item) => item.id === connectionID);
        if (profile) {
            selectProfile(profile);
        }
    }

    function selectProfile(profile) {
        switchConnectionWorkspace(profile.id);
        setSelectedConnectionId(profile.id);
        setShowConnectionForm(false);
        setProfileForm(defaultProfile);
        resetConnectionData();
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

    function disconnectProfile() {
        switchConnectionWorkspace('');
        setSelectedConnectionId('');
        setShowConnectionForm(false);
        setProfileForm(defaultProfile);
        resetConnectionData();
        setStatus('Connection disabled');
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
            switchConnectionWorkspace(saved.id);
            setSelectedConnectionId(saved.id);
            setProfileForm(defaultProfile);
            setShowConnectionForm(false);
            if (!profileForm.id) {
                resetConnectionData();
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
            removeWorkspaceForConnection(selectedConnectionId);
            setSelectedConnectionId('');
            applyWorkspace({queryTabs: [createQueryTab(1)], activeTabId: 1});
            resetConnectionData();
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
        setResultEditError('');
        setResultEditSuccess('');
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
            <Sidebar
                selectedConnectionId={selectedConnectionId}
                connectionOptions={connectionOptions}
                handleConnectionChange={handleConnectionChange}
                selectedProfile={selectedProfile}
                editProfile={editProfile}
                disconnectProfile={disconnectProfile}
                deleteProfile={deleteProfile}
                profiles={profiles}
                selectProfile={selectProfile}
                newProfile={newProfile}
                showConnectionForm={showConnectionForm}
                closeProfileForm={closeProfileForm}
                profileForm={profileForm}
                updateProfileField={updateProfileField}
                testConnection={testConnection}
                saveProfile={saveProfile}
                connectionTestStatus={connectionTestStatus}
                databaseOptions={databaseOptions}
                selectedDatabase={selectedDatabase}
                databases={databases}
                selectDatabase={selectDatabase}
                loadDatabases={loadDatabases}
                setDefaultDatabase={setDefaultDatabase}
                filteredSchemaTables={filteredSchemaTables}
                tableFilter={tableFilter}
                setTableFilter={setTableFilter}
                loadSchema={loadSchema}
                insertTableReference={insertTableReference}
            />

            <main className="main">
                {!selectedConnectionId ? (
                    <section className="editor-empty-state">
                        <strong>Select or add a connection</strong>
                        <span>The SQL editor will appear after a connection is active.</span>
                    </section>
                ) : (
                    <>
                        <QueryToolbar
                            queryTabs={queryTabs}
                            activeTabId={activeTabId}
                            activeTab={activeTab}
                            setActiveTabId={setActiveTabId}
                            closeQueryTab={closeQueryTab}
                            addQueryTab={addQueryTab}
                            updateActiveTab={updateActiveTab}
                            runQuery={runQuery}
                            isRunning={isRunning}
                            killQuery={killQuery}
                            explainQuery={explainQuery}
                            formatQuery={formatQuery}
                            toggleHistory={toggleHistory}
                            saveQuery={saveQuery}
                        />
                        <section className="editor-panel">
                            <Editor
                                height="100%"
                                key={`${selectedConnectionId}:${activeTab?.id || 'empty'}`}
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
                        <ResultsPanel
                            resultEditCount={resultEditCount}
                            cancelResultEdits={cancelResultEdits}
                            showResultUpdateConfirmation={showResultUpdateConfirmation}
                            isRunning={isRunning}
                            activeTab={activeTab}
                            toggleColumnFilters={toggleColumnFilters}
                            clearAllColumnFilters={clearAllColumnFilters}
                            sortedResultColumns={sortedResultColumns}
                            paginatedRows={paginatedRows}
                            resultPageStart={resultPageStart}
                            updateColumnFilter={updateColumnFilter}
                            clearColumnFilter={clearColumnFilter}
                            copyText={copyText}
                            activeSort={activeSort}
                            toggleResultSort={toggleResultSort}
                            canEditResults={canEditResults}
                            resultEdits={resultEdits}
                            resultPrimaryKeyNames={resultPrimaryKeyNames}
                            requestCellUpdate={requestCellUpdate}
                            resultEditError={resultEditError}
                            resultEditSuccess={resultEditSuccess}
                            filteredRows={filteredRows}
                            activeResultPageSize={activeResultPageSize}
                            updateResultPageSize={updateResultPageSize}
                            currentResultPage={currentResultPage}
                            updateResultPage={updateResultPage}
                            resultPageCount={resultPageCount}
                            exportCsv={exportCsv}
                        />
                    </>
                )}
            </main>

            {showHistory && (
                <HistoryPanel
                    history={history}
                    closeHistory={() => setShowHistory(false)}
                    updateActiveTab={updateActiveTab}
                />
            )}
            <UpdateConfirmDialog
                pendingUpdateBatch={pendingUpdateBatch}
                copyText={copyText}
                setPendingUpdateBatch={setPendingUpdateBatch}
                isRunning={isRunning}
                runPendingUpdateBatch={runPendingUpdateBatch}
            />
        </div>
    )
}


function loadPersistedEditorState() {
    if (typeof window === 'undefined') {
        return {activeConnectionId: '', workspaces: {}};
    }
    try {
        const rawValue = window.localStorage.getItem(EDITOR_WORKSPACE_STORAGE_KEY);
        if (!rawValue) {
            return {activeConnectionId: '', workspaces: {}};
        }
        const parsed = JSON.parse(rawValue);
        return {
            activeConnectionId: String(parsed?.activeConnectionId || ''),
            workspaces: normalizePersistedWorkspaces(parsed?.workspaces),
        };
    } catch {
        return {activeConnectionId: '', workspaces: {}};
    }
}

function persistEditorState(activeConnectionId, workspaces) {
    if (typeof window === 'undefined') {
        return;
    }
    try {
        window.localStorage.setItem(EDITOR_WORKSPACE_STORAGE_KEY, JSON.stringify({
            activeConnectionId: activeConnectionId || '',
            workspaces: normalizePersistedWorkspaces(workspaces),
        }));
    } catch {
        // Storage can fail in private mode or if quota is exceeded; the app should keep working in memory.
    }
}

function normalizePersistedWorkspaces(workspaces) {
    if (!workspaces || typeof workspaces !== 'object') {
        return {};
    }
    return Object.entries(workspaces).reduce((next, [connectionId, workspace]) => {
        if (!connectionId) {
            return next;
        }
        next[connectionId] = sanitizeWorkspaceForPersistence(workspace);
        return next;
    }, {});
}

function sanitizeWorkspaceForPersistence(workspace) {
    const normalized = normalizeWorkspace(workspace);
    return {
        activeTabId: normalized.activeTabId,
        queryTabs: normalized.queryTabs.map(sanitizeTabForPersistence),
    };
}

function sanitizeTabForPersistence(tab) {
    return {
        ...createQueryTab(tab.id),
        id: tab.id,
        title: tab.title,
        sql: tab.sql || '',
        limit: tab.limit || 100,
        showFilters: Boolean(tab.showFilters),
        columnFilters: tab.columnFilters || {},
        sort: tab.sort || {column: '', direction: ''},
        result: null,
        resultPage: tab.resultPage || 1,
        resultPageSize: tab.resultPageSize || DEFAULT_RESULT_PAGE_SIZE,
    };
}

export default App
