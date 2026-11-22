import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PROBLEM, PROBLEMS, SUBMIT, SUBMISSION } from '../../graphql/operations';
import { makeSession, problemFixture, problemSummary, submissionFixture } from '../fixtures';
import { renderApp, type Mock } from '../utils';

vi.mock('../../components/CodeEditor', async () => ({
  CodeEditor: (await import('../codeEditorMock')).CodeEditorMock,
}));

const page = (items: unknown[], nextPageToken: string | null = null) => ({
  data: { problems: { __typename: 'ProblemPage', items, nextPageToken } },
});

const problemsMock = (filter: unknown, result: object, pageToken: string | null = null): Mock => ({
  request: { query: PROBLEMS, variables: { filter, pageSize: 20, pageToken } },
  result,
});

describe('listado de problemas', () => {
  it('lista, filtra por dificultad y tag, y pagina', async () => {
    const user = userEvent.setup();
    renderApp({
      route: '/problems',
      mocks: [
        problemsMock(
          null,
          page([problemSummary(1, { tags: ['math', 'greedy'] }), problemSummary(2)], 'tok2'),
        ),
        problemsMock(null, page([problemSummary(3, { difficulty: 'HARD' })]), 'tok2'),
        problemsMock({ difficulty: 'HARD' }, page([problemSummary(3, { difficulty: 'HARD' })])),
        problemsMock({ tags: ['greedy'], difficulty: 'HARD' }, page([])),
        problemsMock({ tags: ['greedy'] }, page([problemSummary(1, { tags: ['math', 'greedy'] })])),
      ],
    });

    expect(await screen.findByText('Problema 1')).toBeInTheDocument();
    expect(screen.getByText('Problema 2')).toBeInTheDocument();

    // Paginación por token.
    await user.click(screen.getByRole('button', { name: /Siguiente/ }));
    expect(await screen.findByText('Problema 3')).toBeInTheDocument();
    expect(screen.getByText('Página 2')).toBeInTheDocument();

    // Filtro por dificultad (reinicia la paginación).
    await user.selectOptions(screen.getByLabelText('Dificultad'), 'HARD');
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/problems?difficulty=HARD'),
    );
    expect(await screen.findByText('Problema 3')).toBeInTheDocument();
    expect(screen.queryByText('Página 2')).not.toBeInTheDocument();

    // Filtro por tag escrito: sin resultados → estado vacío.
    await user.type(screen.getByLabelText('Filtrar por tags'), 'Greedy{Enter}');
    expect(await screen.findByText('No hay problemas que coincidan')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('tags=greedy');

    // Quitar la dificultad deja solo el tag.
    await user.selectOptions(screen.getByLabelText('Dificultad'), '');
    expect(await screen.findByText('Problema 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Quitar tag greedy' })).toBeInTheDocument();
  });

  it('muestra un error entendible y permite reintentar', async () => {
    const user = userEvent.setup();
    renderApp({
      route: '/problems',
      mocks: [
        problemsMock(null, { errors: [{ message: 'down', extensions: { code: 'UNAVAILABLE' } }] }),
        problemsMock(null, page([problemSummary(1)])),
      ],
    });
    expect(
      await screen.findByText('El servicio no está disponible, intenta en un momento.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('Problema 1')).toBeInTheDocument();
  });

  it('un SETTER ve el botón para crear problemas y los borradores', async () => {
    renderApp({
      route: '/problems',
      session: makeSession('SETTER'),
      mocks: [problemsMock(null, page([problemSummary(1, { published: false })]))],
    });
    expect(await screen.findByText('Borrador')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Nuevo problema' })).toBeInTheDocument();
  });
});

describe('detalle de problema y envío', () => {
  const problemMock = (overrides = {}): Mock => ({
    request: { query: PROBLEM, variables: { slug: 'suma' } },
    result: { data: { problem: problemFixture(overrides) } },
  });

  it('muestra enunciado (sin HTML crudo), ejemplos y límites', async () => {
    const { container } = renderApp({ route: '/problems/suma', mocks: [problemMock()] });
    expect(await screen.findByRole('heading', { name: 'Suma de dos números' })).toBeInTheDocument();
    expect(screen.getByText('1000 ms', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('256 MB', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('Porque 1 + 2 = 3.')).toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();
    expect(screen.queryByText(/alert\(1\)/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Inicia sesión' })).toBeInTheDocument();
  });

  it('problema inexistente → estado vacío', async () => {
    renderApp({
      route: '/problems/nada',
      mocks: [
        {
          request: { query: PROBLEM, variables: { slug: 'nada' } },
          result: { data: { problem: null } },
        },
      ],
    });
    expect(await screen.findByText('Problema no encontrado')).toBeInTheDocument();
  });

  it('envía la solución con el lenguaje elegido y abre la submission', async () => {
    const user = userEvent.setup();
    const session = makeSession();
    const code = 'print(sum(map(int, input().split())))';
    renderApp({
      route: '/problems/suma?contest=c1',
      session,
      mocks: [
        problemMock(),
        {
          request: {
            query: SUBMIT,
            variables: {
              input: { problemId: 'p1', language: 'PYTHON3', sourceCode: code, contestId: 'c1' },
            },
          },
          result: { data: { submit: { ...submissionFixture(), language: 'PYTHON3' } } },
        },
        {
          request: { query: SUBMISSION, variables: { id: 's1-abcdef123' } },
          result: { data: { submission: submissionFixture({ verdict: 'ACCEPTED' }) } },
        },
      ],
    });
    await screen.findByRole('heading', { name: 'Suma de dos números' });
    expect(screen.getByText(/Envío dentro del contest/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Lenguaje'), 'PYTHON3');
    const editor = screen.getByLabelText('Código fuente');
    expect((editor as HTMLTextAreaElement).value).toContain('def main');
    await user.clear(editor);
    await user.type(editor, code);
    await user.click(screen.getByRole('button', { name: 'Enviar solución' }));
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/submissions/s1-abcdef123'),
    );
    expect(localStorage.getItem('juez.draft.p1.PYTHON3')).toBe(code);
  });

  it('muestra el error del envío', async () => {
    const user = userEvent.setup();
    renderApp({
      route: '/problems/suma',
      session: makeSession(),
      mocks: [
        problemMock(),
        {
          request: { query: SUBMIT, variables: () => true },
          result: { errors: [{ message: 'contest over', extensions: { code: 'BAD_USER_INPUT' } }] },
        },
      ],
    });
    await screen.findByRole('heading', { name: 'Suma de dos números' });
    await user.click(screen.getByRole('button', { name: 'Enviar solución' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/el contest no está en curso/)).toBeInTheDocument();
  });

  it('el autor ve el link para editar', async () => {
    renderApp({ route: '/problems/suma', session: makeSession('SETTER'), mocks: [problemMock()] });
    expect(await screen.findByRole('link', { name: 'Editar' })).toHaveAttribute(
      'href',
      '/admin/problems/suma/edit',
    );
  });
});
