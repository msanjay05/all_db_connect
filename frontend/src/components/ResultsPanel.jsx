import ResultGrid from './ResultGrid';
import {formatDuration, resultSummary} from '../utils/results';

function ResultsPanel({
    resultEditCount,
    cancelResultEdits,
    showResultUpdateConfirmation,
    isRunning,
    activeTab,
    toggleColumnFilters,
    clearAllColumnFilters,
    sortedResultColumns,
    paginatedRows,
    resultPageStart,
    updateColumnFilter,
    clearColumnFilter,
    copyText,
    activeSort,
    toggleResultSort,
    canEditResults,
    resultEdits,
    resultPrimaryKeyNames,
    requestCellUpdate,
    resultEditError,
    resultEditSuccess,
    filteredRows,
    activeResultPageSize,
    updateResultPageSize,
    currentResultPage,
    updateResultPage,
    resultPageCount,
    exportCsv,
}) {
    return (
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
    );
}

export default ResultsPanel;
