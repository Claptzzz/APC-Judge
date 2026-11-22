import type { CodeEditorProps } from '../components/CodeEditor';

/** CodeMirror no es práctico de tipear en jsdom: en los tests de pantallas se usa un textarea. */
export function CodeEditorMock({ value, onChange, ariaLabel, readOnly }: CodeEditorProps) {
  return (
    <textarea
      aria-label={ariaLabel}
      value={value}
      readOnly={readOnly}
      onChange={(e) => onChange?.(e.target.value)}
    />
  );
}
