import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { CONTEST, CONTESTS, SCOREBOARD } from '../../graphql/operations';
import { SCOREBOARD_DEBOUNCE_MS } from '../../pages/ContestDetailPage';
import { contestFixture, makeSession } from '../fixtures';
import { renderApp, splitTestLink, type Mock } from '../utils';

const row = (rank: number, username: string, solved: number, a: object, b: object) => ({
  __typename: 'ScoreboardRow',
  rank,
  userId: `u-${username}`,
  username,
  solved,
  penaltyMinutes: solved * 30,
  problems: [
    {
      __typename: 'ProblemResult',
      letter: 'A',
      problemId: 'p1',
      solved: false,
      attempts: 0,
      solvedAtMinute: null,
      penaltyMinutes: null,
      firstToSolve: false,
      ...a,
    },
    {
      __typename: 'ProblemResult',
      letter: 'B',
      problemId: 'p2',
      solved: false,
      attempts: 0,
      solvedAtMinute: null,
      penaltyMinutes: null,
      firstToSolve: false,
      ...b,
    },
  ],
});

const board = (items: unknown[]) => ({
  data: {
    scoreboard: {
      __typename: 'Scoreboard',
      contestId: 'c1',
      updatedAt: '2026-11-22T15:00:00.000Z',
      nextPageToken: null,
      items,
    },
  },
});

const contestMock = (overrides = {}): Mock => ({
  request: { query: CONTEST, variables: { id: 'c1' } },
  result: { data: { contest: contestFixture(overrides) } },
});

describe('contest y scoreboard', () => {
  it('muestra el scoreboard y recarga con debounce ante scoreboardUpdated', async () => {
    const session = makeSession();
    let scoreboardCalls = 0;
    const { link, subscriptions } = splitTestLink(
      [
        contestMock(),
        {
          request: {
            query: SCOREBOARD,
            variables: { contestId: 'c1', pageSize: 50, pageToken: null },
          },
          maxUsageCount: Number.POSITIVE_INFINITY,
          result: () => {
            scoreboardCalls += 1;
            return scoreboardCalls === 1
              ? board([
                  row(
                    1,
                    'ana',
                    1,
                    { solved: true, attempts: 2, solvedAtMinute: 15, firstToSolve: true },
                    { attempts: 3 },
                  ),
                ])
              : board([
                  row(
                    1,
                    'beto',
                    2,
                    { solved: true, attempts: 1, solvedAtMinute: 5 },
                    { solved: true, attempts: 1, solvedAtMinute: 9 },
                  ),
                  row(
                    2,
                    'ana',
                    1,
                    { solved: true, attempts: 2, solvedAtMinute: 15, firstToSolve: true },
                    { attempts: 3 },
                  ),
                ]);
          },
        },
      ],
      session,
    );
    renderApp({ route: '/contests/c1', session, link });

    expect(await screen.findByRole('heading', { name: 'Copa UCN' })).toBeInTheDocument();
    expect(screen.getByText(/Termina en/)).toBeInTheDocument();
    // Problema A enlaza con el contest para enviar dentro de él; B no es visible.
    expect(screen.getByRole('link', { name: 'Suma' })).toHaveAttribute(
      'href',
      '/problems/suma?contest=c1',
    );
    expect(screen.getByText('No disponible')).toBeInTheDocument();

    const table = await screen.findByRole('table');
    expect(within(table).getByText('ana')).toBeInTheDocument();
    expect(within(table).getByTitle('Primero en resolverlo')).toHaveTextContent('+1');
    expect(within(table).getByText('−3')).toBeInTheDocument();
    expect(scoreboardCalls).toBe(1);

    // Tres señales seguidas → una sola recarga después del debounce.
    const signal = (n: number) => ({
      result: {
        data: {
          scoreboardUpdated: {
            __typename: 'ScoreboardUpdate',
            contestId: 'c1',
            submissionId: `s${n}`,
            judgedAt: '2026-11-22T15:01:00.000Z',
          },
        },
      },
    });
    act(() => {
      subscriptions.simulateResult(signal(1));
      subscriptions.simulateResult(signal(2));
      subscriptions.simulateResult(signal(3));
    });
    expect(scoreboardCalls).toBe(1);
    await waitFor(
      () => expect(within(screen.getByRole('table')).getByText('beto')).toBeInTheDocument(),
      {
        timeout: SCOREBOARD_DEBOUNCE_MS + 2000,
      },
    );
    expect(scoreboardCalls).toBe(2);
  });

  it('scoreboard vacío y contest próximo', async () => {
    const session = makeSession();
    renderApp({
      route: '/contests/c1',
      session,
      mocks: [
        contestMock({ status: 'UPCOMING', startTime: '2999-01-01T00:00:00.000Z' }),
        {
          request: {
            query: SCOREBOARD,
            variables: { contestId: 'c1', pageSize: 50, pageToken: null },
          },
          result: board([]),
        },
      ],
    });
    expect(await screen.findByText('Todavía no hay participantes')).toBeInTheDocument();
    expect(screen.getByText(/Empieza en/)).toBeInTheDocument();
    expect(
      screen.getByText(/Podrás enviar soluciones cuando el contest empiece/),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Suma' })).toHaveAttribute('href', '/problems/suma');
  });

  it('contest inexistente', async () => {
    renderApp({
      route: '/contests/c9',
      session: makeSession(),
      mocks: [
        {
          request: { query: CONTEST, variables: { id: 'c9' } },
          result: { data: { contest: null } },
        },
      ],
    });
    expect(await screen.findByText('Contest no encontrado')).toBeInTheDocument();
  });
});

describe('listado de contests', () => {
  const contestsMock = (status: string | null, items: unknown[]): Mock => ({
    request: { query: CONTESTS, variables: { status, pageSize: 20, pageToken: null } },
    result: { data: { contests: { __typename: 'ContestPage', items, nextPageToken: null } } },
  });

  it('lista y filtra por estado', async () => {
    const user = userEvent.setup();
    const { problems: _p, description: _d, createdById: _c, ...base } = contestFixture();
    const summary = {
      ...base,
      problems: [{ __typename: 'ContestProblem', letter: 'A', problemId: 'p1' }],
    };
    renderApp({
      route: '/contests',
      session: makeSession('ADMIN'),
      mocks: [contestsMock(null, [summary]), contestsMock('FINISHED', [])],
    });
    expect(await screen.findByText('Copa UCN')).toBeInTheDocument();
    expect(screen.getByText('1 problemas')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Nuevo contest' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Finalizado' }));
    expect(await screen.findByText('No hay contests')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/contests?status=FINISHED');
  });
});
