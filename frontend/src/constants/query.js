export const mysqlKeywords = [
    'SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN',
    'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'INSERT', 'UPDATE', 'DELETE',
    'CREATE', 'ALTER', 'DROP', 'TABLE', 'DATABASE', 'INDEX', 'VIEW', 'TRIGGER',
    'PROCEDURE', 'SHOW', 'DESCRIBE', 'EXPLAIN', 'COUNT', 'SUM', 'AVG', 'MIN',
    'MAX', 'DISTINCT', 'AS', 'ON', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'LIKE',
    'IN', 'BETWEEN', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
];

export const DEFAULT_RESULT_PAGE_SIZE = 50;

export function createQueryTab(id) {
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

export function normalizeWorkspace(workspace) {
    const tabs = Array.isArray(workspace?.queryTabs) && workspace.queryTabs.length
        ? workspace.queryTabs
        : [createQueryTab(1)];
    const activeTabId = tabs.some((tab) => tab.id === workspace?.activeTabId)
        ? workspace.activeTabId
        : tabs[0].id;
    return {queryTabs: tabs, activeTabId};
}
