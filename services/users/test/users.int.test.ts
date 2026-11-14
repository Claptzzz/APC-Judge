// Integración contra la infraestructura local: `pnpm infra:up` (Postgres, Kafka) y llaves
// en .secrets/ (`pnpm jwt:keys`). Arranca la app en proceso con puertos aleatorios.
//   pnpm --filter @juez/users test:int
import { randomUUID } from 'node:crypto';
import { createClient, Code, ConnectError } from '@connectrpc/connect';
import type { Client } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { credentials, loadPackageDefinition, Metadata } from '@grpc/grpc-js';
import type { ServiceClientConstructor } from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { decodeEvent, Topics } from '@juez/contracts';
import { Role, UserService } from '@juez/contracts/es';
import { PROTO_ROOT, protoPath } from '@juez/contracts/proto';
import { createPublicKey } from 'node:crypto';
import { decodeProtectedHeader, jwtVerify } from 'jose';
import kafkajs from 'kafkajs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp } from '../src/app.js';
import type { App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createLogger } from '../src/logger.js';

const suffix = randomUUID().slice(0, 8);
const alice = {
  username: `alice_${suffix}`,
  email: `Alice_${suffix}@Example.com`,
  password: 's3cret-pass',
};

let app: App;
let client: Client<typeof UserService>;
let aliceId = '';
let token = '';

const config = loadConfig({
  ...process.env,
  USERS_HTTP_PORT: '0',
  USERS_GRPC_PORT: '0',
  USERS_OUTBOX_POLL_INTERVAL_MS: '100',
  LOG_LEVEL: process.env.LOG_LEVEL_TEST ?? 'silent',
});

async function expectCode(promise: Promise<unknown>, code: Code) {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ConnectError);
  expect(Code[(err as ConnectError).code]).toBe(Code[code]);
}

beforeAll(async () => {
  const database = createDatabase(config.databaseUrl, { max: 1 });
  await runMigrations(database.db);
  await database.close();
  app = await startApp(config, createLogger(config.logLevel));
  client = createClient(
    UserService,
    createGrpcTransport({ baseUrl: `http://127.0.0.1:${app.ports.grpc}` }),
  );
});

afterAll(async () => {
  await app?.stop();
});

describe('users (integración)', () => {
  it('Register crea un CONTESTANT con el email normalizado', async () => {
    const { user } = await client.register(alice);
    expect(user?.username).toBe(alice.username);
    expect(user?.email).toBe(alice.email.toLowerCase());
    expect(user?.role).toBe(Role.CONTESTANT);
    aliceId = user!.id;
  });

  it('Register rechaza username (sin distinguir mayúsculas) o email repetidos', async () => {
    await expectCode(
      client.register({ ...alice, email: `otro_${suffix}@example.com` }),
      Code.AlreadyExists,
    );
    await expectCode(
      client.register({
        ...alice,
        username: alice.username.toUpperCase(),
        email: `otro_${suffix}@example.com`,
      }),
      Code.AlreadyExists,
    );
    await expectCode(
      client.register({ ...alice, username: `bob_${suffix}`, email: alice.email.toUpperCase() }),
      Code.AlreadyExists,
    );
  });

  it('Login emite un JWT RS256 verificable con GetPublicKey', async () => {
    const res = await client.login({ usernameOrEmail: alice.email, password: alice.password });
    token = res.accessToken;
    expect(res.tokenType).toBe('Bearer');

    const pk = await client.getPublicKey({});
    expect(pk.algorithm).toBe('RS256');
    const { payload } = await jwtVerify(token, createPublicKey(pk.publicKeyPem), {
      issuer: pk.issuer,
      audience: pk.audience,
      algorithms: ['RS256'],
    });
    expect(decodeProtectedHeader(token).kid).toBe(pk.keyId);
    expect(payload).toMatchObject({ sub: aliceId, username: alice.username, role: 'CONTESTANT' });
    expect(payload.exp! - payload.iat!).toBe(3600);
  });

  it('Login con contraseña incorrecta o usuario inexistente: unauthenticated', async () => {
    await expectCode(
      client.login({ usernameOrEmail: alice.username, password: 'incorrecta' }),
      Code.Unauthenticated,
    );
    await expectCode(
      client.login({ usernameOrEmail: `nadie_${suffix}`, password: 'loquesea123' }),
      Code.Unauthenticated,
    );
  });

  it('GetUser y GetUsers exigen JWT y propagan x-request-id', async () => {
    await expectCode(client.getUser({ id: aliceId }), Code.Unauthenticated);

    const headers = { authorization: `Bearer ${token}`, 'x-request-id': `it-${suffix}` };
    let responseHeader: Headers | undefined;
    const { user } = await client.getUser(
      { id: aliceId },
      { headers, onHeader: (h) => (responseHeader = h) },
    );
    expect(user?.id).toBe(aliceId);
    expect(responseHeader?.get('x-request-id')).toBe(`it-${suffix}`);

    const { users } = await client.getUsers(
      { ids: [aliceId, randomUUID(), 'no-es-uuid', aliceId] },
      { headers },
    );
    expect(users.map((u) => u.id)).toEqual([aliceId]);
  });

  it('publica user.registered en Kafka vía outbox', async () => {
    const kafka = new kafkajs.Kafka({
      clientId: `users-it-${suffix}`,
      brokers: config.kafka.brokers,
      logLevel: kafkajs.logLevel.NOTHING,
    });
    const consumer = kafka.consumer({ groupId: `users-it-${suffix}` });
    await consumer.connect();
    await consumer.subscribe({ topic: Topics.USER_REGISTERED, fromBeginning: true });
    try {
      const event = await new Promise<ReturnType<typeof decodeEvent<'user.registered'>>>(
        (resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('sin evento en 20 s')), 20_000);
          void consumer.run({
            eachMessage: async ({ message }) => {
              if (message.key?.toString() !== aliceId) return;
              clearTimeout(timer);
              resolve(decodeEvent(Topics.USER_REGISTERED, message.value));
            },
          });
        },
      );
      expect(event.userId).toBe(aliceId);
      expect(event.username).toBe(alice.username);
      expect(event.eventId).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await consumer.disconnect();
    }
  });

  it('interopera con un cliente @grpc/grpc-js (como el BFF)', async () => {
    const definition = loadSync(protoPath('users'), { includeDirs: [PROTO_ROOT] });
    const pkg = loadPackageDefinition(definition) as unknown as {
      juez: { users: { v1: { UserService: ServiceClientConstructor } } };
    };
    const grpcClient = new pkg.juez.users.v1.UserService(
      `127.0.0.1:${app.ports.grpc}`,
      credentials.createInsecure(),
    );
    const metadata = new Metadata();
    metadata.set('authorization', `Bearer ${token}`);
    try {
      const res = await new Promise<{ user: { id: string; username: string } }>((resolve, reject) =>
        grpcClient.getUser!({ id: aliceId }, metadata, (err: Error | null, value: never) =>
          err ? reject(err) : resolve(value),
        ),
      );
      expect(res.user).toMatchObject({ id: aliceId, username: alice.username });
    } finally {
      grpcClient.close();
    }
  });
});
