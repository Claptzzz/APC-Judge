import { Code, ConnectError, createClient, createRouterTransport } from '@connectrpc/connect';
import type { Client } from '@connectrpc/connect';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { Role, UserService } from '@juez/contracts/es';
import { beforeEach, describe, expect, it } from 'vitest';
import { requestContextInterceptor } from '../../src/grpc/interceptors.js';
import { createUserServiceImpl, toProtoUser } from '../../src/grpc/user-service.js';
import { MAX_BATCH_IDS } from '../../src/validation.js';
import {
  fakeHash,
  fakeVerify,
  InMemoryUsersRepository,
  memoryLogger,
  testTokens,
} from '../helpers.js';

const tokens = testTokens();

let repo: InMemoryUsersRepository;
let client: Client<typeof UserService>;
let log: ReturnType<typeof memoryLogger>;

beforeEach(() => {
  repo = new InMemoryUsersRepository();
  log = memoryLogger();
  const transport = createRouterTransport(
    (router) =>
      router.service(
        UserService,
        createUserServiceImpl({ repo, tokens, hash: fakeHash, verify: fakeVerify }),
      ),
    { router: { interceptors: [requestContextInterceptor(log.logger)] } },
  );
  client = createClient(UserService, transport);
});

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (err) {
    return Code[ConnectError.from(err).code];
  }
}

const ada = { username: 'Ada_L', email: 'Ada@Example.com', password: 'clave-segura' };

async function registerAndLogin(input = ada) {
  const { user } = await client.register(input);
  const { accessToken } = await client.login({
    usernameOrEmail: input.username,
    password: input.password,
  });
  return { user: user!, auth: { headers: { authorization: `Bearer ${accessToken}` } } };
}

describe('Register', () => {
  it('crea un CONTESTANT, normaliza el email y encola user.registered', async () => {
    const { user } = await client.register(ada);
    expect(user).toMatchObject({
      username: 'Ada_L',
      email: 'ada@example.com',
      role: Role.CONTESTANT,
    });
    expect(timestampDate(user!.createdAt!).getTime()).toBeGreaterThan(0);
    expect(repo.users[0]?.passwordHash).toBe('fake$clave-segura');
    expect(repo.events).toEqual([{ userId: user!.id, username: 'Ada_L' }]);
  });

  it('username repetido (sin distinguir mayúsculas) → already_exists', async () => {
    await client.register(ada);
    const err = await client
      .register({ ...ada, username: 'ADA_l', email: 'otro@x.com' })
      .catch((e) => e);
    expect(ConnectError.from(err).code).toBe(Code.AlreadyExists);
    expect(ConnectError.from(err).rawMessage).toBe('El username ya está en uso');
  });

  it('email repetido → already_exists', async () => {
    await client.register(ada);
    const err = await client
      .register({ ...ada, username: 'otra', email: 'ADA@example.com' })
      .catch((e) => e);
    expect(ConnectError.from(err).rawMessage).toBe('El email ya está registrado');
  });

  it.each([
    [{ ...ada, username: 'ab' }, /username/],
    [{ ...ada, username: 'con espacio' }, /username/],
    [{ ...ada, email: 'no-es-email' }, /email/],
    [{ ...ada, password: 'corta' }, /password/],
    [{ ...ada, password: 'x'.repeat(129) }, /password/],
  ])('datos inválidos → invalid_argument (%#)', async (input, message) => {
    const err = ConnectError.from(await client.register(input).catch((e) => e));
    expect(err.code).toBe(Code.InvalidArgument);
    expect(err.rawMessage).toMatch(message);
    expect(repo.users).toHaveLength(0);
  });
});

describe('Login', () => {
  it('acepta username o email (sin distinguir mayúsculas) y devuelve un JWT verificable', async () => {
    const { user } = await client.register(ada);
    for (const usernameOrEmail of ['ada_l', ' ADA@EXAMPLE.COM ']) {
      const res = await client.login({ usernameOrEmail, password: ada.password });
      expect(res.tokenType).toBe('Bearer');
      expect(res.user?.id).toBe(user!.id);
      await expect(tokens.verify(res.accessToken)).resolves.toEqual({
        sub: user!.id,
        username: 'Ada_L',
        role: 'CONTESTANT',
      });
      const ttl = timestampDate(res.expiresAt!).getTime() - Date.now();
      expect(ttl).toBeGreaterThan(3590_000);
      expect(ttl).toBeLessThanOrEqual(3600_000);
    }
  });

  it('contraseña incorrecta y usuario inexistente dan el mismo error', async () => {
    await client.register(ada);
    const wrong = ConnectError.from(
      await client.login({ usernameOrEmail: 'ada_l', password: 'otra-clave' }).catch((e) => e),
    );
    const missing = ConnectError.from(
      await client.login({ usernameOrEmail: 'nadie', password: 'otra-clave' }).catch((e) => e),
    );
    expect([wrong.code, missing.code]).toEqual([Code.Unauthenticated, Code.Unauthenticated]);
    expect(wrong.rawMessage).toBe(missing.rawMessage);
  });

  it('campos vacíos → invalid_argument', async () => {
    expect(await codeOf(client.login({ usernameOrEmail: ' ', password: 'x' }))).toBe(
      'InvalidArgument',
    );
    expect(await codeOf(client.login({ usernameOrEmail: 'ada', password: '' }))).toBe(
      'InvalidArgument',
    );
  });
});

describe('GetUser / GetUsers', () => {
  it('exigen un Bearer válido', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    expect(await codeOf(client.getUser({ id }))).toBe('Unauthenticated');
    expect(await codeOf(client.getUsers({ ids: [id] }))).toBe('Unauthenticated');
    for (const authorization of ['Basic abc', 'Bearer', 'Bearer no.es.jwt']) {
      expect(await codeOf(client.getUser({ id }, { headers: { authorization } }))).toBe(
        'Unauthenticated',
      );
    }
  });

  it('GetUser devuelve el usuario; not_found o invalid_argument según el id', async () => {
    const { user, auth } = await registerAndLogin();
    expect((await client.getUser({ id: user.id }, auth)).user?.username).toBe('Ada_L');
    expect(await codeOf(client.getUser({ id: '00000000-0000-4000-8000-0000000000ff' }, auth))).toBe(
      'NotFound',
    );
    expect(await codeOf(client.getUser({ id: 'abc' }, auth))).toBe('InvalidArgument');
  });

  it('el email solo es visible para el propio usuario o ADMIN', async () => {
    const { user: adaUser, auth: adaAuth } = await registerAndLogin();
    const { user: bob, auth: bobAuth } = await registerAndLogin({
      username: 'bob',
      email: 'bob@x.com',
      password: 'clave-segura',
    });
    expect((await client.getUser({ id: adaUser.id }, adaAuth)).user?.email).toBe('ada@example.com');
    expect((await client.getUser({ id: adaUser.id }, bobAuth)).user?.email).toBe('');
    expect(toProtoUser(repo.users[0]!, { sub: bob.id, role: 'ADMIN' }).email).toBe(
      'ada@example.com',
    );
  });

  it('GetUsers: batch en el orden pedido, sin duplicados, omitiendo inexistentes e inválidos', async () => {
    const { user: a, auth } = await registerAndLogin();
    const { user: b } = await registerAndLogin({
      username: 'bob',
      email: 'bob@x.com',
      password: 'clave-segura',
    });
    const { users } = await client.getUsers(
      { ids: [b.id, 'no-uuid', a.id, '00000000-0000-4000-8000-0000000000ff', b.id] },
      auth,
    );
    expect(users.map((u) => u.username)).toEqual(['bob', 'Ada_L']);
    expect((await client.getUsers({ ids: [] }, auth)).users).toEqual([]);
  });

  it(`GetUsers rechaza más de ${MAX_BATCH_IDS} ids`, async () => {
    const { auth } = await registerAndLogin();
    const ids = Array.from({ length: MAX_BATCH_IDS + 1 }, (_, i) => `id-${i}`);
    expect(await codeOf(client.getUsers({ ids }, auth))).toBe('InvalidArgument');
  });
});

describe('GetPublicKey', () => {
  it('es pública y devuelve PEM, kid, algoritmo, iss y aud', async () => {
    expect(await client.getPublicKey({})).toMatchObject({
      publicKeyPem: tokens.publicKeyPem,
      keyId: 'test-1',
      algorithm: 'RS256',
      issuer: 'juez-users',
      audience: 'juez',
    });
  });
});

describe('logs', () => {
  it('registra cada RPC con requestId y nunca la contraseña', async () => {
    await client.register(ada, { headers: { 'x-request-id': 'req-123' } });
    const line = log.lines().find((l) => l.rpc === 'Register');
    expect(line).toMatchObject({ service: 'users', requestId: 'req-123', code: 'ok', msg: 'rpc' });
    expect(JSON.stringify(log.lines())).not.toContain('clave-segura');
  });
});
