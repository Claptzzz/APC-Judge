import { act, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SUBMISSION, SUBMISSIONS } from '../../graphql/operations';
import { makeSession, submissionFixture } from '../fixtures';
import { renderApp, splitTestLink, type Mock } from '../utils';

vi.mock('../../components/CodeEditor', async () => ({
  CodeEditor: (await import('../codeEditorMock')).CodeEditorMock,
}));

const verdictUpdate = (overrides: Record<string, unknown>) => ({
  result: {
    data: {
      submissionUpdated: {
        __typename: 'Submission',
        id: 's1-abcdef123',
        verdict: 'PENDING',
        timeMs: null,
        memoryKb: null,
        passedCases: null,
        totalCases: null,
        judgedAt: null,
        ...overrides,
      },
    },
  },
});

describe('detalle de submission', () => {
  it('muestra la espera y actualiza el veredicto por submissionUpdated', async () => {
    const session = makeSession();
    const { link, subscriptions } = splitTestLink(
      [
        {
          request: { query: SUBMISSION, variables: { id: 's1-abcdef123' } },
          result: { data: { submission: submissionFixture() } },
        },
      ],
      session,
    );
    renderApp({ route: '/submissions/s1-abcdef123', session, link });

    expect(await screen.findByText('En cola…')).toBeInTheDocument();
    expect(screen.getByText(/espera un juez disponible/)).toBeInTheDocument();
    expect(screen.getByLabelText('Código enviado')).toHaveValue('int main() {}');
    expect(subscriptions.operation?.variables).toEqual({ id: 's1-abcdef123' });

    act(() => subscriptions.simulateResult(verdictUpdate({ verdict: 'JUDGING' })));
    expect(await screen.findByText('Evaluando…')).toBeInTheDocument();

    act(() =>
      subscriptions.simulateResult(
        verdictUpdate({
          verdict: 'ACCEPTED',
          timeMs: 12,
          memoryKb: 3072,
          passedCases: 10,
          totalCases: 10,
          judgedAt: '2026-11-22T15:00:03.000Z',
        }),
      ),
    );
    expect(await screen.findByText('Veredicto')).toBeInTheDocument();
    expect(screen.getAllByText('Aceptado').length).toBeGreaterThan(0);
    expect(screen.getByText('12 ms')).toBeInTheDocument();
    expect(screen.getByText('3.0 MB')).toBeInTheDocument();
    expect(screen.getByText('10 / 10')).toBeInTheDocument();
    expect(screen.queryByText('Evaluando…')).not.toBeInTheDocument();
  });

  it('si la conexión en vivo falla avisa y consulta periódicamente', async () => {
    const session = makeSession();
    const { link, subscriptions } = splitTestLink(
      [
        {
          request: { query: SUBMISSION, variables: { id: 's1-abcdef123' } },
          result: { data: { submission: submissionFixture({ verdict: 'JUDGING' }) } },
          maxUsageCount: Number.POSITIVE_INFINITY,
        },
      ],
      session,
    );
    renderApp({ route: '/submissions/s1-abcdef123', session, link });
    expect(await screen.findByText('Evaluando…')).toBeInTheDocument();
    act(() => subscriptions.simulateResult({ error: new Error('socket closed') }));
    expect(
      await screen.findByText(/consultaremos el estado cada pocos segundos/),
    ).toBeInTheDocument();
  });

  it('veredicto final sin abrir subscription; envío inexistente → vacío', async () => {
    const session = makeSession();
    const { link, subscriptions } = splitTestLink(
      [
        {
          request: { query: SUBMISSION, variables: { id: 's1-abcdef123' } },
          result: {
            data: {
              submission: submissionFixture({
                verdict: 'WRONG_ANSWER',
                passedCases: 3,
                totalCases: 10,
                timeMs: 5,
                memoryKb: 100,
              }),
            },
          },
        },
      ],
      session,
    );
    renderApp({ route: '/submissions/s1-abcdef123', session, link });
    expect(await screen.findByText('3 / 10')).toBeInTheDocument();
    expect(subscriptions.operation).toBeUndefined();
  });

  it('envío inexistente', async () => {
    renderApp({
      route: '/submissions/zzz',
      session: makeSession(),
      mocks: [
        {
          request: { query: SUBMISSION, variables: { id: 'zzz' } },
          result: { data: { submission: null } },
        },
      ],
    });
    expect(await screen.findByText('Envío no encontrado')).toBeInTheDocument();
  });
});

describe('mis submissions', () => {
  const listMock = (items: unknown[]): Mock => ({
    request: {
      query: SUBMISSIONS,
      variables: { filter: { userId: 'u-contestant' }, pageSize: 20, pageToken: null },
    },
    result: { data: { submissions: { __typename: 'SubmissionPage', items, nextPageToken: null } } },
  });

  it('lista los envíos del usuario', async () => {
    renderApp({
      route: '/submissions',
      session: makeSession(),
      mocks: [
        listMock([
          submissionFixture({ verdict: 'ACCEPTED', timeMs: 9, memoryKb: 900 }),
          submissionFixture({ id: 's2', verdict: 'JUDGING', problem: null, contestId: 'c1' }),
        ]),
      ],
    });
    expect(await screen.findByRole('link', { name: 'Suma de dos números' })).toHaveAttribute(
      'href',
      '/submissions/s1-abcdef123',
    );
    expect(screen.getByText('Aceptado')).toBeInTheDocument();
    expect(screen.getByText('Evaluando')).toBeInTheDocument();
    expect(screen.getByText('Problema no disponible')).toBeInTheDocument();
  });

  it('estado vacío', async () => {
    renderApp({ route: '/submissions', session: makeSession(), mocks: [listMock([])] });
    expect(await screen.findByText('Aún no tienes envíos')).toBeInTheDocument();
  });
});
