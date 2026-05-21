function UpdateConfirmDialog({pendingUpdateBatch, copyText, setPendingUpdateBatch, isRunning, runPendingUpdateBatch}) {
    if (!pendingUpdateBatch) {
        return null;
    }

    return (
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
    );
}

export default UpdateConfirmDialog;
