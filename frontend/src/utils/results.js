export function sanitizeFileName(name) {
    return String(name || 'query')
        .trim()
        .replace(/[^a-z0-9_-]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        || 'query';
}

export function resultToCsv(columns, rows) {
    const columnNames = columns.map((column) => column.name);
    const lines = [
        columnNames.map(escapeCsvValue).join(','),
        ...rows.map((row) => columnNames.map((column) => escapeCsvValue(row[column])).join(',')),
    ];
    return lines.join('\n') + '\n';
}

export function escapeCsvValue(value) {
    if (value === null || value === undefined) {
        return '';
    }
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (/[",\n\r]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
}

export function copyValue(value) {
    if (value === null || value === undefined) {
        return '';
    }
    if (typeof value === 'object') {
        return JSON.stringify(value);
    }
    return String(value);
}

export function compareSortValues(left, right) {
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

export function resultSummary(result, visibleRows) {
    return `${visibleRows} shown | ${rowResultLabel(result)} | ${result.success ? 'Success' : 'Failed'}`;
}

export function rowResultLabel(result) {
    const returned = Array.isArray(result.rows) ? result.rows.length : 0;
    if ((result.columns || []).length > 0) {
        return `${returned} row${returned === 1 ? '' : 's'} returned`;
    }
    return `${result.rowsAffected || 0} row${result.rowsAffected === 1 ? '' : 's'} affected`;
}

export function formatDuration(durationMs) {
    if (durationMs === null || durationMs === undefined) {
        return '0 ms';
    }
    if (durationMs < 1000) {
        return `${durationMs} ms`;
    }
    return `${(durationMs / 1000).toFixed(2)} s`;
}

export function isDateColumn(column) {
    const type = String(column?.type || column?.dataType || column?.columnType || '').toLowerCase();
    return ['date', 'time', 'timestamp', 'datetime', 'year'].some((item) => type.includes(item));
}

export function isNumericColumn(column) {
    const type = String(column?.type || column?.dataType || column?.columnType || '').toLowerCase();
    return ['int', 'decimal', 'numeric', 'float', 'double', 'real', 'bit'].some((item) => type.includes(item));
}

export function filterInputClass(column) {
    if (isDateColumn(column)) {
        return 'column-filter-input date-filter';
    }
    if (isNumericColumn(column)) {
        return 'column-filter-input number-filter';
    }
    return 'column-filter-input';
}

export function sortColumnsByName(columns = [], primaryKeyNames = new Set()) {
    return [...columns].sort((left, right) =>
        Number(isPrimaryKeyColumn(right, primaryKeyNames)) - Number(isPrimaryKeyColumn(left, primaryKeyNames))
        || String(left?.name || '').localeCompare(String(right?.name || ''), undefined, {
            numeric: true,
            sensitivity: 'base',
        }),
    );
}

export function isPrimaryKeyColumn(column, primaryKeyNames = new Set()) {
    const columnName = String(column?.name || '').toLowerCase();
    return String(column?.key || '').toUpperCase() === 'PRI' || primaryKeyNames.has(columnName) || columnName === 'id';
}

export function primaryKeyNamesForTable(schema, tableName) {
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

export function lastIdentifierPart(identifier = '') {
    const parts = String(identifier).split('.').map((part) => part.trim()).filter(Boolean);
    return parts[parts.length - 1] || '';
}

export function matchesDatePreset(value, preset) {
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

export function matchesDateComparison(value, filter) {
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

export function dateFilterSelectValue(value = '') {
    if (value.startsWith('datecmp:')) {
        return value.split(':')[1] || '';
    }
    return value;
}

export function dateCompareOperatorValue(value = '') {
    return value.startsWith('datecmp:') ? value.split(':')[1] || '' : '';
}

export function dateFilterNeedsCustomValue(value = '') {
    return value.startsWith('datecmp:');
}

export function hasTimeComponent(value = '') {
    return /[T ]\d{2}:\d{2}/.test(value);
}

export function isDateCompareOperator(value = '') {
    return ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between'].includes(value);
}

export function matchesNumericFilter(value, filter) {
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

export function numericOperatorValue(value = '') {
    if (isSpecialFilter(value)) {
        return value;
    }
    return value.startsWith('num:') ? value.split(':')[1] || '' : '';
}

export function numericFilterValue(value = '') {
    return value.startsWith('num:') ? value.split(':').slice(2).join(':') : '';
}

export function customDateValue(value = '', bound = 'start') {
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

export function customDatePart(value = '', bound = 'start') {
    return customDateValue(value, bound).split('T')[0] || '';
}

export function customTimePart(value = '', bound = 'start') {
    return customDateValue(value, bound).split('T')[1] || '';
}

export function buildDateOperatorFilterValue(currentValue = '', nextOperator = '') {
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

export function buildDateTimeFilterValue(currentValue = '', date = '', time = '', bound = 'start') {
    const operator = dateCompareOperatorValue(currentValue) || 'eq';
    const nextValue = date ? `${date}${time ? `T${time}` : ''}` : '';
    if (operator === 'between') {
        const startValue = bound === 'start' ? nextValue : customDateValue(currentValue, 'start');
        const endValue = bound === 'end' ? nextValue : customDateValue(currentValue, 'end');
        return `datecmp:${operator}:${startValue}|${endValue}`;
    }
    return `datecmp:${operator}:${nextValue}`;
}

export function isSpecialFilter(value = '') {
    return ['NULL', 'NOT NULL', 'Empty', 'Not empty'].includes(value);
}

export function matchesSpecialFilter(value, filter) {
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

export function parseResultDate(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

export function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date, days) {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
}

export function formatValue(value) {
    if (value === null || value === undefined) {
        return 'NULL';
    }
    if (typeof value === 'object') {
        return JSON.stringify(value);
    }
    return String(value);
}

export function formatRowCount(value) {
    if (value === null || value === undefined) {
        return '0';
    }
    return Number(value).toLocaleString();
}

export function formatColumnMeta(column) {
    return [
        column.columnType || column.dataType || 'unknown',
        column.nullable ? 'NULL' : 'NOT NULL',
        column.key,
    ].filter(Boolean).join(' | ');
}

export function columnIconClass(column) {
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

export function columnIconLabel(column) {
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

export function errorMessage(error) {
    return error?.message || String(error);
}
