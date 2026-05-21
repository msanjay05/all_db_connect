import {memo, useCallback} from 'react';
import {
    buildDateOperatorFilterValue,
    buildDateTimeFilterValue,
    copyValue,
    customDatePart,
    customTimePart,
    dateCompareOperatorValue,
    dateFilterNeedsCustomValue,
    dateFilterSelectValue,
    escapeCsvValue,
    filterInputClass,
    formatValue,
    isDateColumn,
    isDateCompareOperator,
    isNumericColumn,
    isPrimaryKeyColumn,
    isSpecialFilter,
    numericFilterValue,
    numericOperatorValue,
} from '../utils/results';
import {getRowKey, makeResultEditKey} from '../utils/resultEdits';

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
                                                <SpecialFilterOptions />
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
                                                <SpecialFilterOptions />
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

function SpecialFilterOptions() {
    return (
        <>
            <option value="NULL">NULL</option>
            <option value="NOT NULL">NOT NULL</option>
            <option value="Empty">Empty</option>
            <option value="Not empty">Not empty</option>
        </>
    );
}

export default ResultGrid;
