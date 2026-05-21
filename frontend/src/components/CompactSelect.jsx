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

    return (
        <div ref={wrapperRef} className={`compact-select ${className}${isOpen ? ' open' : ''}`}>
            <button
                type="button"
                className="compact-select-button"
                disabled={disabled}
                onClick={() => setIsOpen((current) => !current)}
            >
                <span>{selectedOption?.label || placeholder}</span>
                <span className="compact-select-caret" aria-hidden="true">⌄</span>
            </button>
            {isOpen && !disabled && (
                <div className="compact-select-menu" role="listbox">
                    {!value && (
                        <button
                            type="button"
                            className="compact-select-option selected"
                            onClick={() => selectOption('')}
                        >
                            {placeholder}
                        </button>
                    )}
                    {options.map((option) => (
                        <button
                            type="button"
                            key={option.value}
                            className={option.value === value ? 'compact-select-option selected' : 'compact-select-option'}
                            onClick={() => selectOption(option.value)}
                            title={option.title || option.label}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

export default CompactSelect;
