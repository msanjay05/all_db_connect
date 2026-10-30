import {mysqlKeywords} from '../constants/query.js';
import {lastIdentifierPart, sortColumnsByName} from './results.js';

export function getExecutableSql(editor, fullSql) {
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

export function parseSqlStatements(sql) {
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

export function buildExplainSql(sql) {
    const trimmed = stripTrailingSemicolon(sql);
    if (/^explain\b/i.test(trimmed)) {
        return trimmed;
    }
    return `EXPLAIN ${trimmed}`;
}

export function stripSqlComments(sql) {
    return String(sql || '')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/--[^\n\r]*/g, ' ')
        .replace(/#[^\n\r]*/g, ' ');
}

export function unquoteIdentifier(identifier) {
    return String(identifier || '').trim().replace(/^[`"]|[`"]$/g, '');
}

export function unquoteIdentifierPath(identifier) {
    return String(identifier || '')
        .split('.')
        .map((part) => part.trim().replace(/^[`"]|[`"]$/g, '').replace(/``/g, '`').replace(/""/g, '"'))
        .filter(Boolean)
        .join('.');
}

export function inferDatabaseFromSql(sql, knownDatabases = []) {
    if (!sql) {
        return '';
    }
    const cleaned = stripSqlComments(sql).trim();

    const useMatch = cleaned.match(/\buse\s+([`"]?[A-Za-z0-9_$]+[`"]?)/i);
    if (useMatch) {
        const db = unquoteIdentifier(useMatch[1]);
        if (db) {
            return db;
        }
    }

    const pattern = /\b(?:from|(?:(?:left|right|inner|cross|full)\s+)?join|update|into|table)\s+((?:`[^`]+`|"[^"]+"|[A-Za-z0-9_$]+)(?:\s*\.\s*(?:`[^`]+`|"[^"]+"|[A-Za-z0-9_$]+))+)/gi;
    let match;
    let firstCandidate = '';
    while ((match = pattern.exec(cleaned)) !== null) {
        const fullPath = unquoteIdentifierPath(match[1]);
        const parts = fullPath.split('.').filter(Boolean);
        if (parts.length >= 2) {
            const candidate = parts[0];
            if (knownDatabases && knownDatabases.length > 0) {
                const found = knownDatabases.find((db) => db.toLowerCase() === candidate.toLowerCase());
                if (found) {
                    return found;
                }
            }
            if (!firstCandidate) {
                firstCandidate = candidate;
            }
        }
    }

    return firstCandidate;
}

export function quoteIdentifierPath(identifier) {
    return String(identifier || '')
        .split('.')
        .map((part) => quoteIdentifier(part.trim().replace(/^`|`$/g, '')))
        .join('.');
}

export function formatSql(sql) {
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

export function stripTrailingSemicolon(sql) {
    return sql.replace(/;\s*$/, '').trim();
}

const MAX_SUGGESTIONS = 80;
const COLUMN_KEYWORDS = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'DISTINCT', 'AS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END']);
const JOIN_CLAUSE_KEYWORDS = new Set(['JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'CROSS JOIN', 'WHERE', 'ON']);

export function getCompletionWord(model, position) {
    const line = model.getLineContent(position.lineNumber);
    const textBefore = line.slice(0, position.column - 1);
    const match = textBefore.match(/(`(?:[^`]|``)*`?|"(?:[^"]|"")*"?|[\w$]+)$/);
    if (!match) {
        return {word: '', startColumn: position.column};
    }
    return {
        word: unquoteIdentifierPath(match[1]),
        startColumn: position.column - match[0].length,
    };
}

export function completionContext(model, position, word = null) {
    const fullSql = model?.getValue?.() || '';
    const offset = model?.getOffsetAt?.(position) ?? fullSql.length;
    const beforeCursor = fullSql.slice(0, offset);
    const aliasMatch = beforeCursor.match(/(?:^|[^\w`."])((?:`[^`]+`|"[^"]+"|[A-Za-z0-9_$]+))\s*\.\s*[`"]?[A-Za-z0-9_$]*$/);
    const completionWord = word || getCompletionWord(model, position);
    return {
        fullSql,
        beforeCursor,
        aliasQualifier: aliasMatch ? unquoteIdentifier(aliasMatch[1]) : '',
        word: completionWord.word,
        wordPrefix: completionWord.word.toLowerCase(),
    };
}

export function buildDatabaseSuggestions(monaco, databases = [], range, profileType = '') {
    const seen = new Set();
    const suggestions = [];
    for (const db of databases || []) {
        if (!db || seen.has(db.toLowerCase())) {
            continue;
        }
        seen.add(db.toLowerCase());
        const quoted = quoteIdentifier(db, profileType);
        suggestions.push({
            label: db,
            kind: monaco.languages.CompletionItemKind.Module,
            insertText: quoted,
            detail: 'Database',
            sortText: `0_${db}`,
            commitCharacters: ['.'],
            range,
        });
    }
    return suggestions;
}

export function buildSuggestions(
    monaco,
    schema,
    context = {},
    range,
    databases = [],
    schemasCache = {},
    profileType = ''
) {
    const prefix = context.wordPrefix || '';
    const tableRefs = parseSqlTableReferences(context.fullSql || context.beforeCursor || '');

    if (isUseStatementContext(context.beforeCursor)) {
        return finalizeSuggestions(
            buildDatabaseSuggestions(monaco, databases, range, profileType),
            prefix
        );
    }

    if (context.aliasQualifier) {
        const qualifierLower = context.aliasQualifier.toLowerCase();
        const matchedDb = (databases || []).find((db) => db.toLowerCase() === qualifierLower);
        if (matchedDb) {
            const targetSchema = (schemasCache && (schemasCache[qualifierLower] || schemasCache[matchedDb]))
                || (schema?.database?.toLowerCase() === qualifierLower ? schema : null);
            if (targetSchema) {
                return finalizeSuggestions(
                    buildTableSuggestions(monaco, targetSchema, range, true, profileType),
                    prefix
                );
            }
        }
    }

    const scopedTable = resolveSuggestionTable(schema, context, tableRefs, schemasCache);
    if (scopedTable) {
        const columns = buildColumnSuggestions(monaco, scopedTable, range, profileType);
        const keywords = buildKeywordSuggestions(monaco, range, COLUMN_KEYWORDS);
        return finalizeSuggestions([...columns, ...keywords], prefix);
    }

    const joinTableContext = isAfterJoinKeyword(context.beforeCursor);
    const fromContinuationContext = isFromContinuationContext(context.beforeCursor);
    const columnContext = isColumnExpressionContext(context.beforeCursor);

    if (joinTableContext) {
        if (!context.aliasQualifier) {
            const dbSuggestions = buildDatabaseSuggestions(monaco, databases, range, profileType);
            const tableSuggestions = buildTableSuggestions(monaco, schema, range, true, profileType);
            return finalizeSuggestions([...dbSuggestions, ...tableSuggestions], prefix);
        }
        return finalizeSuggestions(
            buildTableSuggestions(monaco, schema, range, true, profileType),
            prefix
        );
    }

    if (fromContinuationContext) {
        const keywords = buildKeywordSuggestions(monaco, range, JOIN_CLAUSE_KEYWORDS);
        return finalizeSuggestions(keywords, prefix);
    }

    if (isOnClauseContinuationContext(context.beforeCursor)) {
        return finalizeSuggestions(buildKeywordSuggestions(monaco, range, new Set(['WHERE'])), prefix);
    }

    if (columnContext && tableRefs.length > 1) {
        const aliases = buildAliasSuggestions(monaco, tableRefs, schema, range, profileType);
        const keywords = buildKeywordSuggestions(monaco, range, COLUMN_KEYWORDS);
        return finalizeSuggestions([...aliases, ...keywords], prefix);
    }

    if (!prefix) {
        return [];
    }

    const keywords = buildKeywordSuggestions(monaco, range);
    const dbSuggestions = buildDatabaseSuggestions(monaco, databases, range, profileType);
    const tableSuggestions = buildTableSuggestions(monaco, schema, range, true, profileType);
    return finalizeSuggestions([...dbSuggestions, ...tableSuggestions, ...keywords], prefix);
}

export function buildColumnSuggestions(monaco, table, range, profileType = '') {
    return sortColumnsByName(table.columns || []).map((column) => ({
        label: column.name,
        kind: monaco.languages.CompletionItemKind.Field,
        insertText: quoteIdentifier(column.name, profileType),
        detail: column.type || 'Column',
        range,
    }));
}

export function buildTableSuggestions(monaco, schema, range, withAlias = true, profileType = '') {
    const seenTables = new Set();
    const suggestions = [];
    for (const table of schema?.tables || []) {
        if (seenTables.has(table.name)) {
            continue;
        }
        seenTables.add(table.name);
        const alias = buildAlias(table.name);
        const quotedTable = quoteIdentifier(table.name, profileType);
        suggestions.push({
            label: table.name,
            kind: monaco.languages.CompletionItemKind.Struct,
            insertText: withAlias ? `${quotedTable} ${alias}` : quotedTable,
            detail: withAlias ? `alias ${alias}` : 'Table',
            sortText: `1_${table.name}`,
            range,
        });
    }
    return suggestions;
}

function buildAliasSuggestions(monaco, tableRefs, schema, range, profileType = '') {
    const seenAliases = new Set();
    const suggestions = [];
    for (const ref of tableRefs) {
        const alias = ref.alias;
        const aliasKey = alias.toLowerCase();
        if (!alias || seenAliases.has(aliasKey)) {
            continue;
        }
        seenAliases.add(aliasKey);
        const table = findSchemaTable(schema, ref.name);
        suggestions.push({
            label: alias,
            kind: monaco.languages.CompletionItemKind.Variable,
            insertText: `${quoteIdentifier(alias, profileType)}.`,
            detail: table?.name || lastIdentifierPart(ref.name),
            range,
        });
    }
    return suggestions;
}

function buildKeywordSuggestions(monaco, range, allowedKeywords = null) {
    return mysqlKeywords
        .filter((keyword) => !allowedKeywords || allowedKeywords.has(keyword))
        .map((keyword) => ({
            label: keyword,
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertText: keyword,
            range,
        }));
}

function finalizeSuggestions(suggestions, prefix = '') {
    const filtered = prefix
        ? suggestions.filter((item) => matchesSuggestionPrefix(item.label, prefix))
        : suggestions;
    return filtered
        .sort((left, right) => compareSuggestionLabels(left.label, right.label, prefix))
        .slice(0, MAX_SUGGESTIONS);
}

function matchesSuggestionPrefix(label, prefix = '') {
    if (!prefix) {
        return true;
    }
    const lowerLabel = label.toLowerCase();
    const lowerPrefix = prefix.toLowerCase();
    if (lowerLabel.startsWith(lowerPrefix)) {
        return true;
    }
    return lowerLabel.split(/\s+/).some((word) => word.startsWith(lowerPrefix));
}

function compareSuggestionLabels(left, right, prefix = '') {
    const lowerPrefix = prefix.toLowerCase();
    const leftStarts = matchesSuggestionPrefix(left, lowerPrefix);
    const rightStarts = matchesSuggestionPrefix(right, lowerPrefix);
    if (leftStarts !== rightStarts) {
        return leftStarts ? -1 : 1;
    }
    return left.localeCompare(right, undefined, {sensitivity: 'base'});
}

export function resolveSuggestionTable(schema, context, tableRefs = null, schemasCache = {}) {
    const refs = tableRefs || parseSqlTableReferences(context.fullSql || context.beforeCursor || '');
    if (context.aliasQualifier) {
        const aliasRef = refs.find((ref) =>
            ref.alias.toLowerCase() === context.aliasQualifier.toLowerCase()
            || lastIdentifierPart(ref.name).toLowerCase() === context.aliasQualifier.toLowerCase(),
        );
        if (aliasRef) {
            const parts = aliasRef.name.split('.');
            let targetSchema = schema;
            if (parts.length > 1) {
                const dbPart = parts[0].toLowerCase();
                if (schemasCache && (schemasCache[dbPart] || schemasCache[parts[0]])) {
                    targetSchema = schemasCache[dbPart] || schemasCache[parts[0]];
                }
            }
            return findSchemaTable(targetSchema, aliasRef.name);
        }
        return null;
    }
    if (refs.length !== 1) {
        return null;
    }
    if (isAfterJoinKeyword(context.beforeCursor) || isFromContinuationContext(context.beforeCursor)) {
        return null;
    }
    if (isColumnExpressionContext(context.beforeCursor)) {
        const parts = refs[0].name.split('.');
        let targetSchema = schema;
        if (parts.length > 1) {
            const dbPart = parts[0].toLowerCase();
            if (schemasCache && (schemasCache[dbPart] || schemasCache[parts[0]])) {
                targetSchema = schemasCache[dbPart] || schemasCache[parts[0]];
            }
        }
        return findSchemaTable(targetSchema, refs[0].name);
    }
    return null;
}

function fromClauseSegment(sql = '') {
    const match = sql.match(/\bfrom\b([\s\S]*?)(?=\bwhere\b|\bgroup\b|\border\b|\bhaving\b|\blimit\b|$)/i);
    return match?.[1] || '';
}

function isCommaSeparatedFrom(fromClause = '') {
    if (!fromClause.trim()) {
        return false;
    }
    const withoutParens = fromClause.replace(/\([^)]*\)/g, '');
    return /,\s*(?:`[^`]+`|"[^"]+"|[A-Za-z0-9_$]+)/i.test(withoutParens);
}

export function parseSqlTableReferences(sql) {
    const refs = [];
    const cleaned = stripSqlComments(sql || '');
    const tablePattern = /\b(?:from|(?:(?:left|right|inner|cross|full)\s+)?join)\s+((?:`[^`]+`|"[^"]+"|[A-Za-z0-9_$]+)(?:\s*\.\s*(?:`[^`]+`|"[^"]+"|[A-Za-z0-9_$]+))?)(?:\s+(?:as\s+)?(`[^`]+`|"[^"]+"|[A-Za-z0-9_$]+))?/gi;
    let match;
    while ((match = tablePattern.exec(cleaned)) !== null) {
        const rawName = unquoteIdentifierPath(match[1]);
        const rawAlias = match[2] ? unquoteIdentifierPath(match[2]) : lastIdentifierPart(rawName);
        if (rawAlias && !isSqlClauseKeyword(rawAlias)) {
            refs.push({name: rawName, alias: rawAlias});
        } else {
            refs.push({name: rawName, alias: lastIdentifierPart(rawName)});
        }
    }
    if (isCommaSeparatedFrom(fromClauseSegment(cleaned))) {
        return [];
    }
    return refs;
}

export function findSchemaTable(schema, tableName) {
    const normalizedName = lastIdentifierPart(tableName).toLowerCase();
    return (schema?.tables || []).find((table) => table.name.toLowerCase() === normalizedName) || null;
}

export function isSelectColumnContext(beforeCursor = '') {
    return isColumnExpressionContext(beforeCursor);
}

export function isTableNameContext(beforeCursor = '') {
    return isAfterJoinKeyword(beforeCursor);
}

export function isUseStatementContext(beforeCursor = '') {
    const current = currentSqlStatement(beforeCursor);
    return /\buse\s+[`"A-Za-z0-9_$]*\s*$/i.test(current);
}

export function isAfterJoinKeyword(beforeCursor = '') {
    const current = currentSqlStatement(beforeCursor);
    // Do not trim — trailing space means the user is typing a table name after FROM/JOIN.
    return /\b(?:from|(?:(?:left|right|inner|cross|full)\s+)?join|into|update|table)\s+(?:(?:`[^`]+`|"[^"]+"|[A-Za-z0-9_$]+)\s*\.\s*)?[`"A-Za-z0-9_$]*\s*$/i.test(current)
        || /\bdelete\s+from\s+(?:(?:`[^`]+`|"[^"]+"|[A-Za-z0-9_$]+)\s*\.\s*)?[`"A-Za-z0-9_$]*\s*$/i.test(current);
}

export function isOnClauseContinuationContext(beforeCursor = '') {
    const current = currentSqlStatement(beforeCursor);
    if (/\b(where|group\s+by|order\s+by|having|limit)\b/i.test(current)) {
        return false;
    }
    const tail = current.trimEnd();
    return /\bon\b[\s\S]*(?:=|<|>|\)|\w)\s+$/i.test(tail);
}

export function isFromContinuationContext(beforeCursor = '') {
    const current = currentSqlStatement(beforeCursor);
    if (!/\bfrom\b/i.test(current) || /\b(where|group\s+by|order\s+by|having|limit)\b/i.test(current)) {
        return false;
    }
    if (isAfterJoinKeyword(beforeCursor)) {
        return false;
    }
    const tail = current.trimEnd();
    return /\b(?:from|(?:(?:left|right|inner|cross|full)\s+)?join)\s+(?:`[^`]+`|"[^"]+"|[A-Za-z0-9_$]+)(?:\s+(?:`[^`]+`|"[^"]+"|[A-Za-z0-9_$]+))?\s+$/i.test(tail);
}

export function isColumnExpressionContext(beforeCursor = '') {
    const current = currentSqlStatement(beforeCursor);
    if (isFromContinuationContext(beforeCursor) || isAfterJoinKeyword(beforeCursor)) {
        return false;
    }
    if (/\bupdate\b[\s\S]*\bset\b[\s\S]*$/i.test(current)) {
        return true;
    }
    if (!/\bselect\b/i.test(current)) {
        return false;
    }
    if (!/\bfrom\b/i.test(current)) {
        return /\bselect\b[\s\S]*$/i.test(current);
    }
    return /\b(?:select|where|on|order\s+by|group\s+by|having|and|or|,\s*)\s*[`\w$.\s]*$/i.test(current);
}

function currentSqlStatement(beforeCursor = '') {
    return stripSqlComments(beforeCursor).split(';').pop() || '';
}

export function isSqlClauseKeyword(value = '') {
    return ['where', 'join', 'left', 'right', 'inner', 'outer', 'group', 'order', 'having', 'limit', 'on'].includes(String(value).toLowerCase());
}

export function quoteIdentifier(identifier, profileType = '') {
    const isPostgres = profileType === 'postgres' || profileType === 'redshift';
    if (isPostgres) {
        if (/^[a-z_][a-z0-9_]*$/.test(identifier)) {
            return identifier;
        }
        return `"${String(identifier).replaceAll('"', '""')}"`;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
        return identifier;
    }
    return `\`${String(identifier).replaceAll('`', '``')}\``;
}

export function buildAlias(name) {
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
