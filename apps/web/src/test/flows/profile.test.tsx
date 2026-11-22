import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { USER_STATS } from '../../graphql/operations';
import { makeSession } from '../fixtures';
import { renderApp } from '../utils';

describe('perfil', () => {
  it('muestra las estadísticas del usuario', async () => {
    renderApp({
      route: '/profile',
      session: makeSession(),
      mocks: [
        {
          request: { query: USER_STATS },
          result: {
            data: {
              userStats: {
                __typename: 'UserStats',
                userId: 'u-contestant',
                username: 'contestant',
                solvedCount: 7,
                attemptedCount: 9,
                totalSubmissions: 21,
                verdictCounts: [
                  { __typename: 'VerdictCount', verdict: 'ACCEPTED', count: 12 },
                  { __typename: 'VerdictCount', verdict: 'WRONG_ANSWER', count: 9 },
                ],
              },
            },
          },
        },
      ],
    });
    expect(await screen.findByText('7')).toBeInTheDocument();
    expect(screen.getByText('Problemas intentados')).toBeInTheDocument();
    expect(screen.getByText('Respuesta incorrecta')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'contestant' })).toBeInTheDocument();
  });

  it('error al cargar', async () => {
    renderApp({
      route: '/profile',
      session: makeSession(),
      mocks: [
        {
          request: { query: USER_STATS },
          result: { errors: [{ message: 'x', extensions: { code: 'UNAVAILABLE' } }] },
        },
      ],
    });
    expect(
      await screen.findByText('El servicio no está disponible, intenta en un momento.'),
    ).toBeInTheDocument();
  });
});
