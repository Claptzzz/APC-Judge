import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONTEST,
  CREATE_CONTEST,
  CREATE_PROBLEM,
  CREATE_TESTCASE_UPLOAD,
  PROBLEM,
  PROBLEMS,
  SCOREBOARD,
  UPDATE_PROBLEM,
} from '../../graphql/operations';
import { contestFixture, makeSession, problemFixture, problemSummary } from '../fixtures';
import { renderApp, type Mock } from '../utils';

afterEach(() => vi.unstubAllGlobals());

const problemMock = (overrides = {}, usage = 1): Mock => ({
  request: { query: PROBLEM, variables: { slug: 'suma' } },
  result: { data: { problem: problemFixture(overrides) } },
  maxUsageCount: usage,
});

describe('crear problema', () => {
  it('valida, crea y lleva a la edición', async () => {
    const user = userEvent.setup();
    renderApp({
      route: '/admin/problems/new',
      session: makeSession('SETTER'),
      mocks: [
        {
          request: {
            query: CREATE_PROBLEM,
            variables: {
              input: {
                title: 'Suma de dos números',
                statement: 'Suma a y b',
                difficulty: 'MEDIUM',
                tags: ['math', 'intro'],
                timeLimitMs: 2000,
                memoryLimitMb: 256,
                examples: [{ input: '1 2', output: '3', explanation: null }],
              },
            },
          },
          result: { data: { createProblem: problemFixture({ difficulty: 'MEDIUM' }) } },
        },
        problemMock({}, Number.POSITIVE_INFINITY),
      ],
    });

    await user.click(await screen.findByRole('button', { name: 'Crear problema' }));
    expect(screen.getByText('El título es obligatorio.')).toBeInTheDocument();
    expect(screen.getByText('El enunciado es obligatorio.')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Título'), 'Suma de dos números');
    await user.type(screen.getByLabelText('Slug (opcional)'), 'Mal Slug');
    expect(screen.getByText('Solo minúsculas, números y guiones.')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Slug (opcional)'));
    await user.selectOptions(screen.getByLabelText('Dificultad'), 'MEDIUM');
    await user.type(screen.getByLabelText('Tags'), 'Math, intro, math');
    await user.clear(screen.getByLabelText('Tiempo límite (ms)'));
    await user.type(screen.getByLabelText('Tiempo límite (ms)'), '2000');
    await user.type(screen.getByLabelText('Enunciado'), 'Suma a y b');

    await user.click(screen.getByRole('button', { name: 'Vista previa' }));
    expect(screen.getByText('Suma a y b')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Editar' }));

    await user.click(screen.getByRole('button', { name: 'Agregar ejemplo' }));
    const example = screen.getByRole('group', { name: 'Ejemplo 1' });
    await user.type(within(example).getByLabelText('Entrada'), '1 2');
    await user.type(within(example).getByLabelText('Salida'), '3');

    await user.click(screen.getByRole('button', { name: 'Crear problema' }));
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/admin/problems/suma/edit'),
    );
    expect(await screen.findByText(/Problema creado/)).toBeInTheDocument();
  });

  it('muestra CONFLICT del slug', async () => {
    const user = userEvent.setup();
    renderApp({
      route: '/admin/problems/new',
      session: makeSession('ADMIN'),
      mocks: [
        {
          request: { query: CREATE_PROBLEM, variables: () => true },
          result: { errors: [{ message: 'slug taken', extensions: { code: 'CONFLICT' } }] },
        },
      ],
    });
    await user.type(await screen.findByLabelText('Título'), 'A');
    await user.type(screen.getByLabelText('Enunciado'), 'x');
    await user.click(screen.getByRole('button', { name: 'Crear problema' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Ya existe un problema con ese slug.',
    );
  });
});

describe('editar problema y subir casos', () => {
  it('sube pares de casos con PUT a la URL prefirmada y publica', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const upload = (ordinal: number): Mock => ({
      request: { query: CREATE_TESTCASE_UPLOAD, variables: { problemId: 'p1', ordinal } },
      result: {
        data: {
          createTestcaseUploadUrl: {
            __typename: 'TestcaseUpload',
            testcaseId: `t${ordinal}`,
            ordinal,
            inputUploadUrl: `http://minio/in${ordinal}`,
            outputUploadUrl: `http://minio/out${ordinal}`,
            expiresAt: '2999-01-01T00:00:00.000Z',
          },
        },
      },
    });
    renderApp({
      route: '/admin/problems/suma/edit',
      session: makeSession('SETTER'),
      mocks: [
        problemMock(),
        upload(3),
        upload(4),
        problemMock({ testcaseCount: 4 }),
        {
          request: { query: UPDATE_PROBLEM, variables: () => true },
          result: {
            data: {
              updateProblem: problemFixture({
                testcaseCount: 4,
                published: true,
                updatedAt: '2026-11-22T16:00:00.000Z',
              }),
            },
          },
        },
      ],
    });

    expect(
      await screen.findByRole('heading', { name: 'Editar: Suma de dos números' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Primer ordinal')).toHaveValue(3);
    await user.upload(screen.getByLabelText('Archivos'), [
      new File(['1 2'], '1.in'),
      new File(['3'], '1.out'),
      new File(['5 5'], '2.in'),
      new File(['10'], '2.ans'),
      new File(['?'], 'leeme.md'),
    ]);
    expect(screen.getByText('leeme.md')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Subir 2 caso(s)' }));

    await waitFor(() => expect(screen.getByText('2 de 2 subidos')).toBeInTheDocument());
    expect(fetchMock.mock.calls.map(([url, init]) => [url, (init as RequestInit).method])).toEqual([
      ['http://minio/in3', 'PUT'],
      ['http://minio/out3', 'PUT'],
      ['http://minio/in4', 'PUT'],
      ['http://minio/out4', 'PUT'],
    ]);
    expect(await screen.findByText(/4 casos de prueba/)).toBeInTheDocument();

    await user.click(screen.getByLabelText(/Publicado/));
    await user.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    expect(await screen.findByText('Cambios guardados.')).toBeInTheDocument();
  });

  it('marca el caso con error si MinIO rechaza la subida', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 403 })));
    renderApp({
      route: '/admin/problems/suma/edit',
      session: makeSession('SETTER'),
      mocks: [
        problemMock({}, Number.POSITIVE_INFINITY),
        {
          request: { query: CREATE_TESTCASE_UPLOAD, variables: { problemId: 'p1', ordinal: 3 } },
          result: {
            data: {
              createTestcaseUploadUrl: {
                __typename: 'TestcaseUpload',
                testcaseId: 't3',
                ordinal: 3,
                inputUploadUrl: 'http://minio/in',
                outputUploadUrl: 'http://minio/out',
                expiresAt: '2999-01-01T00:00:00.000Z',
              },
            },
          },
        },
      ],
    });
    await screen.findByRole('heading', { name: 'Editar: Suma de dos números' });
    await user.upload(screen.getByLabelText('Archivos'), [
      new File(['1'], 'a.in'),
      new File(['1'], 'a.out'),
    ]);
    await user.click(screen.getByRole('button', { name: 'Subir 1 caso(s)' }));
    expect(await screen.findByText('La subida falló (HTTP 403)')).toBeInTheDocument();
  });

  it('otro SETTER no puede editar un problema ajeno', async () => {
    renderApp({
      route: '/admin/problems/suma/edit',
      session: makeSession('SETTER', { id: 'otro' }),
      mocks: [problemMock()],
      me: undefined,
    });
    expect(await screen.findByText(/Solo el autor o un administrador/)).toBeInTheDocument();
  });
});

describe('crear contest', () => {
  it('arma la lista de problemas en orden y crea el contest', async () => {
    const user = userEvent.setup();
    const start = '2026-12-01T10:00';
    const end = '2026-12-01T15:00';
    renderApp({
      route: '/admin/contests/new',
      session: makeSession('SETTER'),
      mocks: [
        {
          request: { query: PROBLEMS, variables: { pageSize: 100 } },
          result: {
            data: {
              problems: {
                __typename: 'ProblemPage',
                items: [
                  problemSummary(1),
                  problemSummary(2, { title: 'Grafos' }),
                  problemSummary(3),
                ],
                nextPageToken: null,
              },
            },
          },
        },
        {
          request: {
            query: CREATE_CONTEST,
            variables: {
              input: {
                title: 'Copa UCN',
                description: '',
                startTime: new Date(start).toISOString(),
                endTime: new Date(end).toISOString(),
                problemIds: ['p2', 'p1'],
              },
            },
          },
          result: {
            data: { createContest: { __typename: 'Contest', id: 'c1', title: 'Copa UCN' } },
          },
        },
        {
          request: { query: CONTEST, variables: { id: 'c1' } },
          result: { data: { contest: contestFixture() } },
        },
        {
          request: {
            query: SCOREBOARD,
            variables: { contestId: 'c1', pageSize: 50, pageToken: null },
          },
          result: {
            data: {
              scoreboard: {
                __typename: 'Scoreboard',
                contestId: 'c1',
                updatedAt: null,
                nextPageToken: null,
                items: [],
              },
            },
          },
        },
      ],
    });

    await user.click(await screen.findByRole('button', { name: 'Crear contest' }));
    expect(screen.getByText('Agrega al menos un problema.')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Título'), 'Copa UCN');
    await user.type(screen.getByLabelText('Inicio'), start);
    await user.type(screen.getByLabelText('Término'), '2026-12-01T09:00');
    expect(screen.getByText('Debe ser posterior al inicio.')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Término'));
    await user.type(screen.getByLabelText('Término'), end);

    await user.click(await screen.findByRole('button', { name: 'Agregar Problema 1' }));
    await user.click(screen.getByRole('button', { name: 'Agregar Problema 3' }));
    await user.type(screen.getByLabelText('Buscar problema'), 'graf');
    await user.click(screen.getByRole('button', { name: 'Agregar Grafos' }));
    await user.click(screen.getByRole('button', { name: 'Quitar Problema 3' }));
    await user.click(screen.getByRole('button', { name: 'Subir Grafos' }));

    const selected = screen.getByRole('list', { name: 'Problemas seleccionados' });
    expect(
      within(selected)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([expect.stringContaining('AGrafos'), expect.stringContaining('BProblema 1')]);

    await user.click(screen.getByRole('button', { name: 'Crear contest' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/contests/c1'));
  });
});
