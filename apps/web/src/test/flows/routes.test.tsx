import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ME, PROBLEMS } from '../../graphql/operations';
import { UNAUTHENTICATED_EVENT } from '../../lib/auth';
import { loadSession } from '../../lib/session';
import { makeSession, problemSummary, userFixture } from '../fixtures';
import { renderApp, type Mock } from '../utils';

const problemsMock = (): Mock => ({
  request: { query: PROBLEMS, variables: { filter: null, pageSize: 20, pageToken: null } },
  result: {
    data: {
      problems: { __typename: 'ProblemPage', items: [problemSummary(1)], nextPageToken: null },
    },
  },
  maxUsageCount: Number.POSITIVE_INFINITY,
});

describe('protección de rutas', () => {
  it.each(['/submissions', '/contests', '/assistant', '/admin/problems/new', '/profile'])(
    'sin sesión, %s redirige al login con next',
    async (route) => {
      renderApp({ route });
      await waitFor(() =>
        expect(screen.getByTestId('location')).toHaveTextContent(
          `/login?next=${encodeURIComponent(route)}`,
        ),
      );
      expect(screen.getByRole('heading', { name: 'Iniciar sesión' })).toBeInTheDocument();
    },
  );

  it.each(['/admin/problems/new', '/admin/contests/new', '/admin/problems/suma/edit'])(
    'un CONTESTANT no puede entrar a %s',
    async (route) => {
      renderApp({ route, session: makeSession('CONTESTANT') });
      expect(await screen.findByText('No tienes acceso a esta sección')).toBeInTheDocument();
    },
  );

  it.each(['SETTER', 'ADMIN'] as const)('un %s puede crear problemas', async (role) => {
    renderApp({ route: '/admin/problems/new', session: makeSession(role) });
    expect(await screen.findByRole('heading', { name: 'Nuevo problema' })).toBeInTheDocument();
  });

  it('el rol se refresca con `me`: si ya no es SETTER pierde el acceso', async () => {
    const session = makeSession('SETTER');
    renderApp({
      route: '/admin/problems/new',
      session,
      me: {
        request: { query: ME },
        result: { data: { me: { ...userFixture(session), role: 'CONTESTANT' } } },
      },
    });
    expect(await screen.findByText('No tienes acceso a esta sección')).toBeInTheDocument();
    expect(loadSession()?.user.role).toBe('CONTESTANT');
  });

  it('cierra la sesión si `me` responde UNAUTHENTICATED', async () => {
    renderApp({
      route: '/problems',
      session: makeSession(),
      mocks: [problemsMock()],
      me: {
        request: { query: ME },
        result: { errors: [{ message: 'expired', extensions: { code: 'UNAUTHENTICATED' } }] },
      },
    });
    await waitFor(() => expect(loadSession()).toBeNull());
    expect(await screen.findByRole('link', { name: 'Iniciar sesión' })).toBeInTheDocument();
  });

  it('el evento de token rechazado cierra la sesión', async () => {
    renderApp({ route: '/problems', session: makeSession(), mocks: [problemsMock()] });
    expect(await screen.findByText('contestant')).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new Event(UNAUTHENTICATED_EVENT));
    });
    await waitFor(() => expect(loadSession()).toBeNull());
    expect(await screen.findByRole('link', { name: 'Iniciar sesión' })).toBeInTheDocument();
  });

  it('ruta desconocida → 404 y la raíz va a problemas', async () => {
    renderApp({ route: '/no-existe' });
    expect(await screen.findByText('Página no encontrada')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('link', { name: 'Ir a los problemas' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/problems'));
  });
});
