import {isDateColumn, isNumericColumn} from './results';
import {quoteIdentifier, quoteIdentifierPath, stripSqlComments, stripTrailingSemicolon, unquoteIdentifierPath} from './sql';

export function inferEditableTableName(sql) {
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

export function buildUpdateSql(tableName, column, rawValue, rowKey) {
    const valueSql = formatEditedValueForSql(rawValue, column);
    const keySql = formatIdValueForSql(rowKey?.value);
    if (!tableName || !column?.name || !rowKey?.name || valueSql === null || keySql === null) {
        return '';
    }
    return `UPDATE ${quoteIdentifierPath(tableName)} SET ${quoteIdentifier(column.name)} = ${valueSql} WHERE ${quoteIdentifier(rowKey.name)} = ${keySql}`;
}

export function formatEditedValueForSql(rawValue, column) {
    const text = String(rawValue ?? '').trim();
    if (/^null$/i.test(text)) {
        return 'NULL';
    }
    if (isNumericColumn(column)) {
        return /^-?\d+(\.\d+)?$/.test(text) ? text : null;
    }
    return `'${escapeSqlString(String(rawValue ?? ''))}'`;
}

export function validateEditedValue(rawValue, column) {
    const text = String(rawValue ?? '').trim();
    if (/^null$/i.test(text)) {
        return '';
    }
    if (isNumericColumn(column) && !/^-?\d+(\.\d+)?$/.test(text)) {
        return `${column.name} expects a numeric value`;
    }
    if (isDateColumn(column) && !isValidSqlDateValue(text, column)) {
        return `${column.name} expects a valid ${dateColumnInputLabel(column)} value`;
    }
    return '';
}

export function isValidSqlDateValue(value, column) {
    const type = String(column?.type || column?.dataType || column?.columnType || '').toLowerCase();
    if (type.includes('time') && !type.includes('date') && !type.includes('timestamp')) {
        return /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(value);
    }
    if (type.includes('year')) {
        return /^\d{4}$/.test(value);
    }
    if (type.includes('date') && !type.includes('time') && !type.includes('timestamp')) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
            return false;
        }
        return isRealDateParts(value);
    }
    const match = value.match(/^(\d{4}-\d{2}-\d{2})(?:[ T]([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?)?$/);
    return Boolean(match && isRealDateParts(match[1]));
}

export function isRealDateParts(value) {
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

export function dateColumnInputLabel(column) {
    const type = String(column?.type || column?.dataType || column?.columnType || '').toLowerCase();
    if (type.includes('time') && !type.includes('date') && !type.includes('timestamp')) {
        return 'time';
    }
    if (type.includes('year')) {
        return 'year';
    }
    if (type.includes('date') && !type.includes('time') && !type.includes('timestamp')) {
        return 'date';
    }
    return 'date/time';
}

export function formatIdValueForSql(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    const text = String(value);
    return /^-?\d+(\.\d+)?$/.test(text) ? text : `'${escapeSqlString(text)}'`;
}

export function escapeSqlString(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/'/g, "''");
}

export function getRowKey(row, primaryKeyNames = new Set()) {
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

export function makeResultEditKey(keyName, keyValue, columnName) {
    return `${String(keyName)}\u0000${String(keyValue)}\u0000${String(columnName)}`;
}
