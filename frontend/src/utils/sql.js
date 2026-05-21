import {mysqlKeywords} from '../constants/query';
import {lastIdentifierPart, sortColumnsByName} from './results';

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

export function unquoteIdentifierPath(identifier) {
    return String(identifier || '')
        .split('.')
        .map((part) => part.trim().replace(/^`|`$/g, '').replace(/``/g, '`'))
        .filter(Boolean)
        .join('.');
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

export function completionContext(model, position) {
    const fullSql = model?.getValue?.() || '';
    const offset = model?.getOffsetAt?.(position) ?? fullSql.length;
    const beforeCursor = fullSql.slice(0, offset);
    const aliasMatch = beforeCursor.match(/(?:^|[^\w`])(`?[\w$]+`?)\.\w*$/);
    return {
        fullSql,
        beforeCursor,
        aliasQualifier: aliasMatch ? unquoteIdentifierPath(aliasMatch[1]) : '',
    };
}

export function buildSuggestions(monaco, schema, context = {}) {
    const scopedTable = resolveSuggestionTable(schema, context);
    if (scopedTable) {
        return buildColumnSuggestions(monaco, scopedTable);
    }

    const suggestions = mysqlKeywords.map((keyword) => ({
        label: keyword,
        kind: monaco.languages.CompletionItemKind.Keyword,
        insertText: keyword,
    }));

    const seenTables = new Set();
    const seenColumns = new Set();
    for (const table of schema?.tables || []) {
        if (!seenTables.has(table.name)) {
            seenTables.add(table.name);
            suggestions.push({
                label: table.name,
                kind: monaco.languages.CompletionItemKind.Struct,
                insertText: `${quoteIdentifier(table.name)} ${buildAlias(table.name)}`,
            });
        }

        for (const suggestion of buildColumnSuggestions(monaco, table)) {
            const key = suggestion.label.toLowerCase();
            if (!seenColumns.has(key)) {
                seenColumns.add(key);
                suggestions.push(suggestion);
            }
        }
    }

    return suggestions;
}

export function buildColumnSuggestions(monaco, table) {
    return sortColumnsByName(table.columns || []).map((column) => ({
        label: column.name,
        kind: monaco.languages.CompletionItemKind.Field,
        insertText: column.name,
    }));
}

export function resolveSuggestionTable(schema, context) {
    const tableRefs = parseSqlTableReferences(context.fullSql || context.beforeCursor || '');
    if (context.aliasQualifier) {
        const aliasRef = tableRefs.find((ref) =>
            ref.alias.toLowerCase() === context.aliasQualifier.toLowerCase()
            || lastIdentifierPart(ref.name).toLowerCase() === context.aliasQualifier.toLowerCase(),
        );
        return aliasRef ? findSchemaTable(schema, aliasRef.name) : null;
    }
    const singleTable = tableRefs.length === 1 ? tableRefs[0] : null;
    return singleTable && isSelectColumnContext(context.beforeCursor) ? findSchemaTable(schema, singleTable.name) : null;
}

export function parseSqlTableReferences(sql) {
    const refs = [];
    const cleaned = stripSqlComments(sql || '');
    const tablePattern = /\b(from|join)\s+((?:`[^`]+`|[A-Za-z0-9_$]+)(?:\s*\.\s*(?:`[^`]+`|[A-Za-z0-9_$]+))?)(?:\s+(?:as\s+)?(`[^`]+`|[A-Za-z0-9_$]+))?/gi;
    let match;
    while ((match = tablePattern.exec(cleaned)) !== null) {
        const rawName = unquoteIdentifierPath(match[2]);
        const rawAlias = match[3] ? unquoteIdentifierPath(match[3]) : lastIdentifierPart(rawName);
        if (rawAlias && !isSqlClauseKeyword(rawAlias)) {
            refs.push({name: rawName, alias: rawAlias});
        } else {
            refs.push({name: rawName, alias: lastIdentifierPart(rawName)});
        }
    }
    const fromSection = cleaned.split(/\bwhere\b|\bgroup\b|\border\b|\bhaving\b|\blimit\b/i)[0] || '';
    return fromSection.includes(',') ? [] : refs;
}

export function findSchemaTable(schema, tableName) {
    const normalizedName = lastIdentifierPart(tableName).toLowerCase();
    return (schema?.tables || []).find((table) => table.name.toLowerCase() === normalizedName) || null;
}

export function isSelectColumnContext(beforeCursor = '') {
    const current = stripSqlComments(beforeCursor).split(';').pop() || '';
    const hasSelect = /\bselect\b/i.test(current);
    const lastFrom = current.search(/\bfrom\b/i);
    const lastSelect = current.search(/\bselect\b/i);
    return hasSelect && (lastFrom === -1 || lastSelect < lastFrom);
}

export function isSqlClauseKeyword(value = '') {
    return ['where', 'join', 'left', 'right', 'inner', 'outer', 'group', 'order', 'having', 'limit', 'on'].includes(String(value).toLowerCase());
}

export function quoteIdentifier(identifier) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
        return identifier;
    }
    return `\`${identifier.replaceAll('`', '``')}\``;
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
