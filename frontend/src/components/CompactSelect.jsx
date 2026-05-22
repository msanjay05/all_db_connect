import {useEffect, useRef, useState} from 'react';

function CompactSelect({value, options, placeholder, disabled = false, onChange, className = ''}) {
    const [isOpen, setIsOpen] = useState(false);
    const wrapperRef = useRef(null);
    const selectedOption = options.find((option) => option.value === value);

    useEffect(() => {
        function closeOnOutsideClick(event) {
            if (!wrapperRef.current?.contains(event.target)) {
                setIsOpen(false);
            }
        }

        document.addEventListener('mousedown', closeOnOutsideClick);
        return () => document.removeEventListener('mousedown', closeOnOutsideClick);
    }, []);

    function selectOption(nextValue) {
        setIsOpen(false);
        onChange?.(nextValue);
    }

    function handleOptionMouseDown(event, nextValue) {
        event.preventDefault();
        event.stopPropagation();
        selectOption(nextValue);
    }

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
                <span className="compact-select-caret" aria-hidden="true">⌄</span>
            </button>
            {isOpen && !disabled && (
                <div className="compact-select-menu" role="listbox">
                    {!value && (
                        <button
                            type="button"
                            className="compact-select-option selected"
                            onMouseDown={(event) => handleOptionMouseDown(event, '')}
                        >
                            <span className="compact-select-label"><span>{placeholder}</span></span>
                        </button>
                    )}
                    {options.map((option) => (
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
                    ))}
                </div>
            )}
        </div>
    );
}

export default CompactSelect;
