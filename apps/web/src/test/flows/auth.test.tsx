import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LOGIN, ME, PROBLEMS, REGISTER } from '../../graphql/operations';
import { loadSession } from '../../lib/session';
import { FUTURE, makeSession, problemSummary, userFixture } from '../fixtures';
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

function payloadFor(session = makeSession()) {
  const { createdAt: _createdAt, ...user } = userFixture(session);
  return { __typename: 'AuthPayload' as const, token: session.token, expiresAt: FUTURE, user };
}

describe('login', () => {
  it('inicia sesión, guarda el token y vuelve a la ruta pedida', async () => {
    const session = makeSession();
    const user = userEvent.setup();
    renderApp({
      route: '/login?next=%2Fproblems%3Ftags%3Dmath',
      mocks: [
        {
          request: {
            query: LOGIN,
            variables: { input: { usernameOrEmail: 'ana', password: 'secreta123' } },
          },
          result: { data: { login: payloadFor(session) } },
        },
        {
          request: {
            query: PROBLEMS,
            variables: { filter: { tags: ['math'] }, pageSize: 20, pageToken: null },
          },
          result: {
            data: {
              problems: {
                __typename: 'ProblemPage',
                items: [problemSummary(1)],
                nextPageToken: null,
              },
            },
          },
        },
        { request: { query: ME }, result: { data: { me: userFixture(session) } } },
      ],
    });

    await user.type(screen.getByLabelText('Usuario o email'), ' ana ');
    await user.type(screen.getByLabelText('Contraseña'), 'secreta123');
    await user.click(screen.getByRole('button', { name: 'Entrar' }));

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/problems?tags=math'),
    );
    expect(loadSession()?.token).toBe(session.token);
    expect(await screen.findByText(session.user.username)).toBeInTheDocument();
  });

  it('muestra un mensaje claro con credenciales incorrectas', async () => {
    const user = userEvent.setup();
    renderApp({
      route: '/login',
      mocks: [
        {
          request: {
            query: LOGIN,
            variables: { input: { usernameOrEmail: 'ana', password: 'mala12345' } },
          },
          result: {
            errors: [{ message: 'invalid credentials', extensions: { code: 'UNAUTHENTICATED' } }],
          },
        },
      ],
    });
    await user.type(screen.getByLabelText('Usuario o email'), 'ana');
    await user.type(screen.getByLabelText('Contraseña'), 'mala12345');
    await user.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Usuario o contraseña incorrectos.');
    expect(loadSession()).toBeNull();
  });

  it('traduce UNAVAILABLE cuando el servicio no responde', async () => {
    const user = userEvent.setup();
    renderApp({
      route: '/login',
      mocks: [
        {
          request: {
            query: LOGIN,
            variables: { input: { usernameOrEmail: 'ana', password: 'secreta123' } },
          },
          result: { errors: [{ message: 'users down', extensions: { code: 'UNAVAILABLE' } }] },
        },
      ],
    });
    await user.type(screen.getByLabelText('Usuario o email'), 'ana');
    await user.type(screen.getByLabelText('Contraseña'), 'secreta123');
    await user.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /el servicio no está disponible, intenta en un momento/i,
    );
  });

  it('con sesión activa redirige fuera del login', async () => {
    renderApp({ route: '/login', session: makeSession(), mocks: [problemsMock()] });
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/problems'));
  });
});

describe('registro', () => {
  it('valida el formulario antes de enviar', async () => {
    const user = userEvent.setup();
    renderApp({ route: '/register' });
    await user.type(screen.getByLabelText('Nombre de usuario'), 'a!');
    await user.type(screen.getByLabelText('Email'), 'no-es-email');
    await user.type(screen.getByLabelText('Contraseña'), 'corta');
    await user.type(screen.getByLabelText('Repite la contraseña'), 'otra');
    await user.click(screen.getByRole('button', { name: 'Crear cuenta' }));
    expect(screen.getByText(/Entre 3 y 32 caracteres/)).toBeInTheDocument();
    expect(screen.getByText('Ingresa un email válido.')).toBeInTheDocument();
    expect(screen.getByText('Entre 8 y 128 caracteres.')).toBeInTheDocument();
    expect(screen.getByText('Las contraseñas no coinciden.')).toBeInTheDocument();
  });

  it('informa CONFLICT y luego crea la cuenta', async () => {
    const session = makeSession();
    const user = userEvent.setup();
    const input = { username: 'ana', email: 'ana@x.cl', password: 'secreta123' };
    renderApp({
      route: '/register',
      mocks: [
        {
          request: { query: REGISTER, variables: { input } },
          result: { errors: [{ message: 'taken', extensions: { code: 'CONFLICT' } }] },
        },
        {
          request: { query: REGISTER, variables: { input } },
          result: { data: { register: payloadFor(session) } },
        },
        problemsMock(),
        { request: { query: ME }, result: { data: { me: userFixture(session) } } },
      ],
    });
    await user.type(screen.getByLabelText('Nombre de usuario'), 'ana');
    await user.type(screen.getByLabelText('Email'), 'ana@x.cl');
    await user.type(screen.getByLabelText('Contraseña'), 'secreta123');
    await user.type(screen.getByLabelText('Repite la contraseña'), 'secreta123');
    await user.click(screen.getByRole('button', { name: 'Crear cuenta' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('ya está registrado');

    await user.click(screen.getByRole('button', { name: 'Crear cuenta' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/problems'));
    expect(loadSession()?.user.username).toBe(session.user.username);
  });
});

describe('logout', () => {
  it('limpia el token y la cache de Apollo', async () => {
    const user = userEvent.setup();
    renderApp({ route: '/problems', session: makeSession(), mocks: [problemsMock()] });
    expect(await screen.findByText('Problema 1')).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: 'Cerrar sesión' })[0]!);
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/login'));
    expect(loadSession()).toBeNull();
    expect(screen.getByRole('link', { name: 'Iniciar sesión' })).toBeInTheDocument();
  });
});
