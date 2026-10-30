import {useEffect, useRef, useState} from 'react';

function CompactSelect({
    value,
    options,
    placeholder,
    disabled = false,
    onChange,
    className = '',
    searchable = false,
    searchPlaceholder = 'Search...',
}) {
    const [isOpen, setIsOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const wrapperRef = useRef(null);
    const searchInputRef = useRef(null);
    const selectedOption = options.find((option) => option.value === value);

    useEffect(() => {
        function closeOnOutsideClick(event) {
            if (!wrapperRef.current?.contains(event.target)) {
                setIsOpen(false);
                setSearchQuery('');
            }
        }

        document.addEventListener('mousedown', closeOnOutsideClick);
        return () => document.removeEventListener('mousedown', closeOnOutsideClick);
    }, []);

    useEffect(() => {
        if (isOpen && searchable) {
            const timer = setTimeout(() => {
                searchInputRef.current?.focus();
            }, 30);
            return () => clearTimeout(timer);
        } else {
            setSearchQuery('');
        }
    }, [isOpen, searchable]);

    function selectOption(nextValue) {
        setIsOpen(false);
        setSearchQuery('');
        onChange?.(nextValue);
    }

    function handleOptionMouseDown(event, nextValue) {
        event.preventDefault();
        event.stopPropagation();
        selectOption(nextValue);
    }

    const filteredOptions = searchQuery.trim()
        ? options.filter((option) => {
            const labelText = typeof option.label === 'string' ? option.label : '';
            const valText = String(option.value ?? '');
            const q = searchQuery.trim().toLowerCase();
            return labelText.toLowerCase().includes(q) || valText.toLowerCase().includes(q);
        })
        : options;

    return (
        <div ref={wrapperRef} className={`compact-select ${className}${isOpen ? ' open' : ''}`}>
            <button
                type="button"
                className="compact-select-button"
                disabled={disabled}
                onClick={(event) => {
                    event.stopPropagation();
                    setIsOpen((current) => !current);
                }}
            >
                <span className="compact-select-label">
                    {selectedOption?.icon}
                    <span>{selectedOption?.label || placeholder}</span>
                </span>
                <svg
                    className="compact-select-caret"
                    viewBox="0 0 16 16"
                    width="12"
                    height="12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                >
                    <path d="m4 6 4 4 4-4" />
                </svg>
            </button>
            {isOpen && !disabled && (
                <div className="compact-select-menu" role="listbox">
                    {searchable && (
                        <div className="compact-select-search-wrap" onClick={(event) => event.stopPropagation()}>
                            <svg
                                className="compact-select-search-icon"
                                viewBox="0 0 16 16"
                                width="12"
                                height="12"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                aria-hidden="true"
                            >
                                <circle cx="7" cy="7" r="4.5" />
                                <path d="m10.5 10.5 3.5 3.5" />
                            </svg>
                            <input
                                ref={searchInputRef}
                                type="text"
                                className="compact-select-search-input"
                                value={searchQuery}
                                placeholder={searchPlaceholder}
                                onChange={(event) => setSearchQuery(event.target.value)}
                                onKeyDown={(event) => event.stopPropagation()}
                            />
                            {searchQuery && (
                                <button
                                    type="button"
                                    className="compact-select-search-clear"
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        setSearchQuery('');
                                        searchInputRef.current?.focus();
                                    }}
                                    aria-label="Clear search"
                                >
                                    ×
                                </button>
                            )}
                        </div>
                    )}
                    {!value && !searchQuery && (
                        <button
                            type="button"
                            className="compact-select-option selected"
                            onMouseDown={(event) => handleOptionMouseDown(event, '')}
                        >
                            <span className="compact-select-label"><span>{placeholder}</span></span>
                        </button>
                    )}
                    {filteredOptions.length === 0 ? (
                        <div className="compact-select-empty">No results found</div>
                    ) : (
                        filteredOptions.map((option) => (
                            <button
                                type="button"
                                key={option.value}
                                className={option.value === value ? 'compact-select-option selected' : 'compact-select-option'}
                                onMouseDown={(event) => handleOptionMouseDown(event, option.value)}
                                title={option.title || (typeof option.label === 'string' ? option.label : '')}
                            >
                                <span className="compact-select-label">
                                    {option.icon}
                                    <span>{option.label}</span>
                                </span>
                            </button>
                        ))
                    )}
                </div>
            )}
        </div>
    );
}

export default CompactSelect;
