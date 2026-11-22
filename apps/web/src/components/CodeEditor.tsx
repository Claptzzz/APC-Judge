import { indentWithTab } from '@codemirror/commands';
import { cpp } from '@codemirror/lang-cpp';
import { python } from '@codemirror/lang-python';
import { Annotation, Compartment, EditorState } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { useEffect, useRef } from 'react';
import type { Language } from '../gen/graphql';
import { useTheme } from '../lib/theme';

export interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  language: Language;
  readOnly?: boolean;
  ariaLabel?: string;
  minHeight?: string;
}

function languageExtension(language: Language) {
  return language === 'PYTHON3' ? python() : cpp();
}

/** Marca los cambios que vienen de `value` (no del usuario) para no reportarlos en `onChange`. */
const external = Annotation.define<boolean>();

const baseTheme = EditorView.theme({
  '&': { fontSize: '13px' },
  '.cm-content': { fontFamily: 'var(--font-mono)' },
  '.cm-gutters': { fontFamily: 'var(--font-mono)' },
});

/** Editor CodeMirror 6 controlado. El estado vive en CodeMirror; `value` se sincroniza si cambia desde afuera. */
export function CodeEditor({
  value,
  onChange,
  language,
  readOnly = false,
  ariaLabel = 'Editor de código',
  minHeight = '320px',
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const languageConf = useRef(new Compartment());
  const themeConf = useRef(new Compartment());
  const readOnlyConf = useRef(new Compartment());
  const { resolved } = useTheme();

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // Montaje: se crea una sola vez; lo demás se reconfigura con Compartments.
  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          keymap.of([indentWithTab]),
          baseTheme,
          EditorView.contentAttributes.of({ 'aria-label': ariaLabel }),
          EditorView.theme({ '.cm-scroller, .cm-content': { minHeight } }),
          languageConf.current.of(languageExtension(language)),
          themeConf.current.of(resolved === 'dark' ? oneDark : []),
          readOnlyConf.current.of([
            EditorState.readOnly.of(readOnly),
            EditorView.editable.of(!readOnly),
          ]),
          EditorView.updateListener.of((update) => {
            const fromProps = update.transactions.some((tr) => tr.annotation(external));
            if (update.docChanged && !fromProps) onChangeRef.current?.(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // Solo al montar: los cambios posteriores se aplican en los efectos de abajo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view.current?.dispatch({
      effects: languageConf.current.reconfigure(languageExtension(language)),
    });
  }, [language]);

  useEffect(() => {
    view.current?.dispatch({
      effects: themeConf.current.reconfigure(resolved === 'dark' ? oneDark : []),
    });
  }, [resolved]);

  useEffect(() => {
    view.current?.dispatch({
      effects: readOnlyConf.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);

  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) {
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: value },
        annotations: external.of(true),
      });
    }
  }, [value]);

  return (
    <div
      ref={host}
      data-testid="code-editor"
      className="overflow-hidden rounded-lg border border-zinc-300 dark:border-zinc-700"
    />
  );
}
