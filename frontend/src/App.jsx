import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import './App.css';
import AboutDialog from './components/AboutDialog';
import HistoryPanel from './components/HistoryPanel';
import DatabaseTypeIcon from './components/DatabaseTypeIcon';
import QueryToolbar from './components/QueryToolbar';
import ResultsPanel from './components/ResultsPanel';
import SqlEditor from './components/SqlEditor';
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
    getCompletionWord,
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
    ListConnectionQueryHistory,
    SaveCSVFile,
    SaveConnectionProfile,
    SetDefaultDatabase,
    TestConnection,
} from "../wailsjs/go/main/App";
import {ClipboardSetText} from "../wailsjs/runtime/runtime";

const defaultProfile = {
    id: '',
    type: 'mysql',
    name: 'Local MySQL',
    host: '127.0.0.1',
    port: 3306,
    username: 'root',
    password: '',
    database: '',
    connectionString: '',
    filePath: '',
    account: '',
    projectId: '',
    region: '',
    warehouse: '',
    role: '',
    authType: '',
    extraParams: '',
    readOnly: false,
};
const databaseTypeOptions = [
    {value: 'athena', label: 'Amazon Athena', icon: <DatabaseTypeIcon type="athena" />},
    {value: 'redshift', label: 'Amazon Redshift', icon: <DatabaseTypeIcon type="redshift" />},
    {value: 'bigquery', label: 'BigQuery', icon: <DatabaseTypeIcon type="bigquery" />},
    {value: 'clickhouse', label: 'ClickHouse', icon: <DatabaseTypeIcon type="clickhouse" />},
    {value: 'databricks', label: 'Databricks', icon: <DatabaseTypeIcon type="databricks" />},
    {value: 'druid', label: 'Druid', icon: <DatabaseTypeIcon type="druid" />},
    {value: 'druid-jdbc', label: 'Druid JDBC', icon: <DatabaseTypeIcon type="druid-jdbc" />},
    {value: 'mysql', label: 'MySQL', icon: <DatabaseTypeIcon type="mysql" />},
    {value: 'postgres', label: 'PostgreSQL', icon: <DatabaseTypeIcon type="postgres" />},
    {value: 'presto', label: 'Presto', icon: <DatabaseTypeIcon type="presto" />},
    {value: 'snowflake', label: 'Snowflake', icon: <DatabaseTypeIcon type="snowflake" />},
    {value: 'spark-sql', label: 'Spark SQL', icon: <DatabaseTypeIcon type="spark-sql" />},
    {value: 'sqlserver', label: 'SQL Server', icon: <DatabaseTypeIcon type="sqlserver" />},
    {value: 'mongodb', label: 'MongoDB', icon: <DatabaseTypeIcon type="mongodb" />},
    {value: 'sqlite', label: 'SQLite', icon: <DatabaseTypeIcon type="sqlite" />},
    {value: 'starburst', label: 'Starburst (Trino)', icon: <DatabaseTypeIcon type="starburst" />},
];
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
    const [showAbout, setShowAbout] = useState(false);
    const [tableFilter, setTableFilter] = useState('');
    const [status, setStatus] = useState('Ready');
    const [isRunning, setIsRunning] = useState(false);
    const [editorHeight, setEditorHeight] = useState(360);
    const [resultEdits, setResultEdits] = useState({});
    const [resultEditError, setResultEditError] = useState('');
    const [resultEditSuccess, setResultEditSuccess] = useState('');
    const [pendingUpdateBatch, setPendingUpdateBatch] = useState(null);
    const schemaRef = useRef(schema);
    const mainRef = useRef(null);
    const editorRef = useRef(null);
    const completionProviderRef = useRef(null);
    const persistSqlTimeoutRef = useRef(null);
    const runQueryRef = useRef(() => {});
    const activeTabIdRef = useRef(activeTabId);
    const queryTabsRef = useRef(queryTabs);
    const selectedConnectionIdRef = useRef(selectedConnectionId);
    const selectedDatabaseRef = useRef(selectedDatabase);
    const connectionWorkspacesRef = useRef(connectionWorkspaces);
    const restoredInitialConnectionRef = useRef(false);
    const resetIdleTimerRef = useRef(null);
    const disconnectProfileRef = useRef(null);

    useEffect(() => {
        schemaRef.current = schema;
    }, [schema]);

    useEffect(() => {
        refreshProfiles();
        refreshHistory();
        return () => {
            completionProviderRef.current?.dispose?.();
            completionProviderRef.current = null;
            window.clearTimeout(persistSqlTimeoutRef.current);
        };
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
    const editableTableName = useMemo(
        () => inferEditableTableName(activeTab?.executedSql || ''),
        [activeTab?.executedSql],
    );
    const canEditResults = Boolean(selectedProfile && isSqlProfile(selectedProfile) && !selectedProfile.readOnly && editableTableName);
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

    const resultsPanelState = useMemo(() => ({
        result: activeTab?.result ?? null,
        showFilters: Boolean(activeTab?.showFilters),
        columnFilters: activeTab?.columnFilters ?? {},
    }), [activeTab?.result, activeTab?.showFilters, activeTab?.columnFilters]);

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
            icon: <DatabaseTypeIcon type={profile.type} />,
            title: connectionTarget(profile),
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
        disconnectProfileRef.current = disconnectProfile;
    });

    const triggerActivity = useCallback(() => {
        resetIdleTimerRef.current?.();
    }, []);

    useEffect(() => {
        if (!selectedConnectionId) {
            resetIdleTimerRef.current = null;
            return;
        }

        let idleTimer;

        const resetIdleTimer = () => {
            if (idleTimer) {
                window.clearTimeout(idleTimer);
            }
            idleTimer = window.setTimeout(() => {
                disconnectProfileRef.current?.();
                setStatus('Disconnected due to 1 minute of inactivity');
            }, 60000);
        };

        resetIdleTimerRef.current = resetIdleTimer;
        resetIdleTimer();

        const events = ['mousemove', 'mousedown', 'keydown', 'scroll', 'click'];
        const handleActivity = () => {
            resetIdleTimer();
        };

        events.forEach((event) => {
            window.addEventListener(event, handleActivity, true);
        });

        return () => {
            if (idleTimer) {
                window.clearTimeout(idleTimer);
            }
            events.forEach((event) => {
                window.removeEventListener(event, handleActivity, true);
            });
            resetIdleTimerRef.current = null;
        };
    }, [selectedConnectionId]);

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
            persistEditorState('', nextWorkspaces);
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

    const flushActiveTabSql = useCallback(() => {
        const tabId = activeTabIdRef.current;
        const sql = editorRef.current?.getValue?.() ?? '';
        setQueryTabs((currentTabs) => {
            const currentTab = currentTabs.find((tab) => tab.id === tabId);
            if (!currentTab || currentTab.sql === sql) {
                return currentTabs;
            }
            return currentTabs.map((tab) => tab.id === tabId ? {...tab, sql} : tab);
        });
    }, []);

    const scheduleIdleSqlFlush = useCallback(() => {
        window.clearTimeout(persistSqlTimeoutRef.current);
        persistSqlTimeoutRef.current = window.setTimeout(() => {
            persistSqlTimeoutRef.current = null;
            flushActiveTabSql();
        }, 1500);
    }, [flushActiveTabSql]);

    const handleEditorSqlChange = useCallback(() => {
        triggerActivity();
        scheduleIdleSqlFlush();
    }, [triggerActivity, scheduleIdleSqlFlush]);

    const selectQueryTab = useCallback((tabId) => {
        if (tabId === activeTabIdRef.current) {
            return;
        }
        window.clearTimeout(persistSqlTimeoutRef.current);
        flushActiveTabSql();
        setActiveTabId(tabId);
    }, [flushActiveTabSql]);

    function addQueryTab() {
        window.clearTimeout(persistSqlTimeoutRef.current);
        flushActiveTabSql();
        const nextId = Math.max(...queryTabs.map((tab) => tab.id), 0) + 1;
        setQueryTabs((currentTabs) => [...currentTabs, createQueryTab(nextId)]);
        setActiveTabId(nextId);
    }

    function closeQueryTab(tabId) {
        if (queryTabs.length === 1) {
            return;
        }
        if (tabId === activeTabId) {
            window.clearTimeout(persistSqlTimeoutRef.current);
            flushActiveTabSql();
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

    async function refreshHistory(connectionID = selectedConnectionIdRef.current) {
        if (!connectionID) {
            setHistory([]);
            return;
        }
        try {
            setHistory((await ListConnectionQueryHistory(connectionID, 100)) || []);
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
        setProfileForm((current) => {
            if (field === 'type') {
                return profileDefaultsForType(value, current);
            }
            return {
                ...current,
                [field]: field === 'port' ? Number(value) : value,
            };
        });
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
        if (showHistory) {
            refreshHistory(profile.id);
        }
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
            type: profile.type || 'mysql',
            name: profile.name,
            host: profile.host,
            port: profile.port || defaultPortForType(profile.type || 'mysql'),
            username: profile.username,
            password: '',
            database: profile.database || '',
            connectionString: profile.connectionString || '',
            filePath: profile.filePath || '',
            account: profile.account || '',
            projectId: profile.projectId || '',
            region: profile.region || '',
            warehouse: profile.warehouse || '',
            role: profile.role || '',
            authType: profile.authType || '',
            extraParams: profile.extraParams || '',
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
        setHistory([]);
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
            const databaseToSelect = defaultDatabase && loadedDatabases?.includes(defaultDatabase)
                ? defaultDatabase
                : (loadedDatabases?.length === 1 ? loadedDatabases[0] : '');
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
            const database = ['mongodb', 'bigquery'].includes(profileForm.type) ? profileForm.database : '';
            const saved = await SaveConnectionProfile({...profileForm, database});
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
            setHistory([]);
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
        triggerActivity();
        window.clearTimeout(persistSqlTimeoutRef.current);
        flushActiveTabSql();
        await executeCurrentSql('run');
    }

    async function explainQuery() {
        triggerActivity();
        window.clearTimeout(persistSqlTimeoutRef.current);
        flushActiveTabSql();
        await executeCurrentSql('explain');
    }

    async function executeCurrentSql(mode) {
        const connectionID = selectedConnectionIdRef.current;
        const database = selectedDatabaseRef.current;
        const tabId = activeTabIdRef.current;
        const tab = queryTabsRef.current.find((item) => item.id === tabId);
        const profile = profiles.find((item) => item.id === connectionID);
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
        if (mode === 'explain' && profile?.type === 'mongodb') {
            setStatus('Explain is not available for MongoDB JSON commands');
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
        updateQueryTab(tabId, {sql: fullSql, executedSql: executableSql, result: null, resultPage: 1});
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
        const updateSql = buildUpdateSql(editableTableName, column, nextValue, rowKey, selectedProfile?.type);
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
        triggerActivity();
        window.clearTimeout(persistSqlTimeoutRef.current);
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
        triggerActivity();
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
        triggerActivity();
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
        scheduleIdleSqlFlush();
    }

    function handleEditorMount(editor, monaco) {
        editorRef.current = editor;
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
            runQueryRef.current();
        });
        completionProviderRef.current?.dispose?.();
        completionProviderRef.current = monaco.languages.registerCompletionItemProvider('sql', {
            triggerCharacters: ['.', ' '],
            provideCompletionItems: (model, position) => {
                const word = getCompletionWord(model, position);
                const range = {
                    startLineNumber: position.lineNumber,
                    endLineNumber: position.lineNumber,
                    startColumn: word.startColumn,
                    endColumn: position.column,
                };
                const context = completionContext(model, position, word);
                return {
                    suggestions: buildSuggestions(monaco, schemaRef.current, context, range),
                };
            },
        });
        editor.focus();
    }

    function startEditorResize(event) {
        const mainElement = mainRef.current;
        if (!mainElement) {
            return;
        }
        event.preventDefault();
        const bounds = mainElement.getBoundingClientRect();
        const toolbarHeight = 36;
        const dividerHeight = 8;
        const minEditorHeight = 140;
        const minResultsHeight = 180;
        const maxEditorHeight = Math.max(minEditorHeight, bounds.height - toolbarHeight - dividerHeight - minResultsHeight);
        let nextEditorHeight = editorHeight;
        let animationFrame = 0;

        function applyEditorHeight() {
            animationFrame = 0;
            mainElement.style.gridTemplateRows = `36px ${nextEditorHeight}px 8px minmax(0, 1fr)`;
        }

        function updateEditorHeight(pointerEvent) {
            const nextHeight = pointerEvent.clientY - bounds.top - toolbarHeight;
            nextEditorHeight = Math.min(Math.max(nextHeight, minEditorHeight), maxEditorHeight);
            if (!animationFrame) {
                animationFrame = window.requestAnimationFrame(applyEditorHeight);
            }
        }

        function stopResize() {
            if (animationFrame) {
                window.cancelAnimationFrame(animationFrame);
                applyEditorHeight();
            }
            setEditorHeight(nextEditorHeight);
            mainElement.classList.remove('resizing');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            window.removeEventListener('pointermove', updateEditorHeight);
            window.removeEventListener('pointerup', stopResize);
            window.removeEventListener('pointercancel', stopResize);
        }

        mainElement.classList.add('resizing');
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';
        window.addEventListener('pointermove', updateEditorHeight);
        window.addEventListener('pointerup', stopResize);
        window.addEventListener('pointercancel', stopResize);
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
                databaseTypeOptions={databaseTypeOptions}
                openAboutDialog={() => setShowAbout(true)}
            />

            <div className={showHistory ? 'content-area show-history' : 'content-area'}>
                <main
                    ref={mainRef}
                    className="main"
                    style={selectedConnectionId ? {gridTemplateRows: `36px ${editorHeight}px 8px minmax(0, 1fr)`} : undefined}
                >
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
                                setActiveTabId={selectQueryTab}
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
                                <SqlEditor
                                    tabId={activeTab?.id || 'empty'}
                                    connectionId={selectedConnectionId}
                                    initialSql={activeTab?.sql || ''}
                                    language={selectedProfile?.type === 'mongodb' ? 'json' : 'sql'}
                                    onMount={handleEditorMount}
                                    onSqlChange={handleEditorSqlChange}
                                />
                            </section>
                            <div
                                className="vertical-resize-handle"
                                role="separator"
                                aria-orientation="horizontal"
                                aria-label="Resize editor and results panels"
                                title="Drag to resize editor and results"
                                onPointerDown={startEditorResize}
                                onDoubleClick={() => setEditorHeight(360)}
                            />
                            <ResultsPanel
                                resultEditCount={resultEditCount}
                                cancelResultEdits={cancelResultEdits}
                                showResultUpdateConfirmation={showResultUpdateConfirmation}
                                isRunning={isRunning}
                                result={resultsPanelState.result}
                                showFilters={resultsPanelState.showFilters}
                                columnFilters={resultsPanelState.columnFilters}
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
                        copyText={copyText}
                    />
                )}
            </div>
            <UpdateConfirmDialog
                pendingUpdateBatch={pendingUpdateBatch}
                copyText={copyText}
                setPendingUpdateBatch={setPendingUpdateBatch}
                isRunning={isRunning}
                runPendingUpdateBatch={runPendingUpdateBatch}
            />
            {showAbout && <AboutDialog onClose={() => setShowAbout(false)} />}
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

function defaultPortForType(type) {
    switch (type) {
        case 'clickhouse':
            return 9000;
        case 'presto':
        case 'starburst':
            return 8080;
        case 'postgres':
            return 5432;
        case 'redshift':
            return 5439;
        case 'sqlserver':
            return 1433;
        case 'mongodb':
            return 27017;
        case 'sqlite':
            return 0;
        case 'mysql':
        default:
            return 3306;
    }
}

function profileDefaultsForType(type, current = defaultProfile) {
    const normalizedType = type || 'mysql';
    const base = {
        ...current,
        type: normalizedType,
        connectionString: current.connectionString || '',
        filePath: current.filePath || '',
        account: current.account || '',
        projectId: current.projectId || '',
        region: current.region || '',
        warehouse: current.warehouse || '',
        role: current.role || '',
        authType: current.authType || '',
        extraParams: current.extraParams || '',
    };
    if (normalizedType === 'athena') {
        return {...base, name: current.name === 'Local MySQL' ? 'Amazon Athena' : current.name, host: '', port: 0, region: current.region || 'us-east-1', username: '', database: ''};
    }
    if (normalizedType === 'bigquery') {
        return {...base, name: current.name === 'Local MySQL' ? 'BigQuery' : current.name, host: '', port: 0, username: '', database: ''};
    }
    if (normalizedType === 'clickhouse') {
        return {...base, name: current.name === 'Local MySQL' ? 'ClickHouse' : current.name, host: current.host || '127.0.0.1', port: 9000, username: current.username || 'default'};
    }
    if (normalizedType === 'databricks') {
        return {...base, name: current.name === 'Local MySQL' ? 'Databricks' : current.name, host: current.host || '', port: 0, username: ''};
    }
    if (normalizedType === 'druid' || normalizedType === 'druid-jdbc') {
        return {...base, name: current.name === 'Local MySQL' ? (normalizedType === 'druid-jdbc' ? 'Druid JDBC' : 'Druid') : current.name, host: current.host || '127.0.0.1:8888', port: 0, username: ''};
    }
    if (normalizedType === 'presto') {
        return {...base, name: current.name === 'Local MySQL' ? 'Presto' : current.name, host: current.host || '127.0.0.1', port: 8080, username: current.username || 'presto'};
    }
    if (normalizedType === 'starburst') {
        return {...base, name: current.name === 'Local MySQL' ? 'Starburst' : current.name, host: current.host || '', port: 8080, username: current.username || 'trino'};
    }
    if (normalizedType === 'redshift') {
        return {...base, name: current.name === 'Local MySQL' ? 'Amazon Redshift' : current.name, host: current.host || '', port: 5439};
    }
    if (normalizedType === 'snowflake') {
        return {...base, name: current.name === 'Local MySQL' ? 'Snowflake' : current.name, host: '', port: 0};
    }
    if (normalizedType === 'spark-sql') {
        return {...base, name: current.name === 'Local MySQL' ? 'Spark SQL' : current.name, host: current.host || '', port: 0};
    }
    if (normalizedType === 'sqlserver') {
        return {...base, name: current.name === 'Local MySQL' ? 'SQL Server' : current.name, host: current.host || '127.0.0.1', port: 1433};
    }
    if (normalizedType === 'postgres') {
        return {...base, name: current.name === 'Local MySQL' ? 'Local PostgreSQL' : current.name, host: current.host || '127.0.0.1', port: 5432};
    }
    if (normalizedType === 'mongodb') {
        return {...base, name: current.name === 'Local MySQL' ? 'Local MongoDB' : current.name, host: current.host || '127.0.0.1', port: 27017};
    }
    if (normalizedType === 'sqlite') {
        return {...base, name: current.name === 'Local MySQL' ? 'Local SQLite' : current.name, host: '', port: 0, username: '', password: '', database: ''};
    }
    return {...base, name: current.name || 'Local MySQL', host: current.host || '127.0.0.1', port: 3306, username: current.username || 'root'};
}

function isSqlProfile(profile) {
    return (profile?.type || 'mysql') !== 'mongodb';
}

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

export default App
