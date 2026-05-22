import {memo} from 'react';
import Editor from '@monaco-editor/react';

const editorOptions = {
    minimap: {enabled: false},
    fontSize: 14,
    automaticLayout: true,
    wordWrap: 'on',
    snippetSuggestions: 'none',
    wordBasedSuggestions: 'off',
    quickSuggestions: {other: true, comments: false, strings: false},
    suggestOnTriggerCharacters: true,
    acceptSuggestionOnCommitCharacter: false,
    tabCompletion: 'on',
    suggest: {
        showWords: false,
        filterGraceful: true,
        localityBonus: true,
        snippetsPreventQuickSuggestions: false,
    },
};

function SqlEditor({tabId, connectionId, initialSql, language, onMount, onSqlChange}) {
    return (
        <Editor
            key={`${connectionId}:${tabId}`}
            height="100%"
            defaultLanguage={language}
            theme="vs-dark"
            defaultValue={initialSql || ''}
            onChange={onSqlChange}
            onMount={onMount}
            options={editorOptions}
        />
    );
}

export default memo(SqlEditor);
