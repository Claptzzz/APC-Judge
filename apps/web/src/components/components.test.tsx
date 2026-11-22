import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditorView } from '@codemirror/view';
import { describe, expect, it, vi } from 'vitest';
import { PROBLEMS } from '../graphql/operations';
import { ThemeProvider } from '../lib/theme';
import { makeSession, problemSummary } from '../test/fixtures';
import { renderApp } from '../test/utils';
import { CodeEditor } from './CodeEditor';
import { ErrorBoundary } from './ErrorBoundary';
import { Markdown } from './Markdown';

const problemsMock = {
  request: { query: PROBLEMS, variables: { filter: null, pageSize: 20, pageToken: null } },
  result: {
    data: {
      problems: { __typename: 'ProblemPage', items: [problemSummary(1)], nextPageToken: null },
    },
  },
  maxUsageCount: Number.POSITIVE_INFINITY,
};

describe('Layout', () => {
  it('cambia entre tema claro, oscuro y del sistema', async () => {
    const user = userEvent.setup();
    renderApp({ route: '/problems', mocks: [problemsMock] });
    await screen.findByText('Problema 1');
    const toggle = screen.getByRole('button', { name: /Tema del sistema/ });
    await user.click(toggle);
    expect(document.documentElement).not.toHaveClass('dark');
    expect(localStorage.getItem('juez.theme')).toBe('light');
    await user.click(screen.getByRole('button', { name: /Tema claro/ }));
    expect(document.documentElement).toHaveClass('dark');
    await user.click(screen.getByRole('button', { name: /Tema oscuro/ }));
    expect(localStorage.getItem('juez.theme')).toBe('system');
  });

  it('menú móvil con los links de la sesión', async () => {
    const user = userEvent.setup();
    renderApp({ route: '/problems', session: makeSession(), mocks: [problemsMock] });
    await screen.findByText('Problema 1');
    await user.click(screen.getByRole('button', { name: 'Abrir menú' }));
    const menu = screen.getByRole('navigation', { name: 'Menú móvil' });
    expect(menu).toHaveTextContent('Asistente');
    expect(menu).toHaveTextContent('Mi perfil (contestant)');
    await user.click(screen.getByRole('button', { name: 'Cerrar menú' }));
    expect(screen.queryByRole('navigation', { name: 'Menú móvil' })).not.toBeInTheDocument();
  });
});

describe('CodeEditor (CodeMirror real)', () => {
  it('reporta las ediciones del usuario', () => {
    const onChange = vi.fn();
    render(
      <ThemeProvider>
        <CodeEditor value="a" language="CPP17" onChange={onChange} ariaLabel="Código" />
      </ThemeProvider>,
    );
    const view = EditorView.findFromDOM(
      screen.getByTestId('code-editor').firstElementChild as HTMLElement,
    );
    act(() => view?.dispatch({ changes: { from: 1, insert: 'b' } }));
    expect(onChange).toHaveBeenCalledWith('ab');
  });

  it('monta, refleja el valor y cambia de lenguaje y tema', async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ThemeProvider>
        <CodeEditor value="int main() {}" language="CPP17" onChange={onChange} ariaLabel="Código" />
      </ThemeProvider>,
    );
    const content = screen.getByRole('textbox', { name: 'Código' });
    expect(content).toHaveTextContent('int main() {}');

    rerender(
      <ThemeProvider>
        <CodeEditor
          value="print(1)"
          language="PYTHON3"
          onChange={onChange}
          ariaLabel="Código"
          readOnly
        />
      </ThemeProvider>,
    );
    expect(screen.getByRole('textbox', { name: 'Código' })).toHaveTextContent('print(1)');
    expect(screen.getByRole('textbox', { name: 'Código' })).toHaveAttribute(
      'contenteditable',
      'false',
    );
    // Un cambio de `value` desde afuera no se reporta como edición del usuario.
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('Markdown', () => {
  it('abre links externos en otra pestaña y descarta HTML crudo', () => {
    const { container } = render(
      <Markdown>{'[docs](https://x.cl) <img src=x onerror=alert(1)>'}</Markdown>,
    );
    expect(screen.getByRole('link', { name: 'docs' })).toHaveAttribute('target', '_blank');
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('ErrorBoundary', () => {
  it('muestra un aviso en vez de una pantalla en blanco', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let shouldThrow = true;
    function Boom() {
      if (shouldThrow) throw new Error('boom');
      return <p>recuperado</p>;
    }
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Algo salió mal al mostrar esta pantalla')).toBeInTheDocument();
    shouldThrow = false;
    await act(async () => {
      await userEvent.setup().click(screen.getByRole('button', { name: 'Reintentar' }));
    });
    expect(screen.getByText('recuperado')).toBeInTheDocument();
    spy.mockRestore();
  });
});
