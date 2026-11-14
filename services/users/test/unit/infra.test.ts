import { createClient } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { UserService } from '@juez/contracts/es';
import { describe, expect, it } from 'vitest';
import { ensureAdmin } from '../../src/bootstrap.js';
import { createDatabase } from '../../src/db/client.js';
import { findUniqueViolation } from '../../src/db/errors.js';
import { MIGRATIONS_DIR } from '../../src/db/migrate.js';
import { createGrpcServer } from '../../src/grpc/server.js';
import { createUserServiceImpl } from '../../src/grpc/user-service.js';
import { createHttpServer } from '../../src/http/server.js';
import { createMetrics } from '../../src/metrics.js';
import { DrizzleUsersRepository, DuplicateUserError } from '../../src/repository.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  chainFake,
  fakeHash,
  InMemoryUsersRepository,
  memoryLogger,
  silentLogger,
  testTokens,
} from '../helpers.js';

describe('HTTP (Fastify)', () => {
  const metrics = createMetrics({ defaultMetrics: false });
  metrics.outboxPublished.inc(3);

  it('/health responde ok sin consultar dependencias', async () => {
    const app = createHttpServer({ logger: silentLogger, metrics, readiness: {} });
    const res = await app.inject({ url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('/ready: 200 si las obligatorias están ok; las informativas no bloquean', async () => {
    const app = createHttpServer({
      logger: silentLogger,
      metrics,
      readiness: { database: async () => {} },
      informational: {
        kafka: async () => {
          throw new Error('productor desconectado');
        },
      },
    });
    const res = await app.inject({ url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ready',
      checks: {
        database: { status: 'ok' },
        kafka: { status: 'down', error: 'productor desconectado' },
      },
    });
  });

  it('/ready: 503 si una obligatoria falla', async () => {
    const app = createHttpServer({
      logger: silentLogger,
      metrics,
      readiness: {
        database: async () => {
          throw new Error('timeout');
        },
      },
    });
    const res = await app.inject({ url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      status: 'not_ready',
      checks: { database: { status: 'down' } },
    });
  });

  it('/metrics expone el formato de Prometheus', async () => {
    const app = createHttpServer({ logger: silentLogger, metrics, readiness: {} });
    const res = await app.inject({ url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('outbox_published_total{service="users"} 3');
  });
});

describe('servidor gRPC (HTTP/2)', () => {
  it('atiende el protocolo gRPC sobre h2c y cierra ordenadamente', async () => {
    const server = createGrpcServer((router) =>
      router.service(
        UserService,
        createUserServiceImpl({ repo: new InMemoryUsersRepository(), tokens: testTokens() }),
      ),
    );
    await server.listen(0, '127.0.0.1');
    const address = server.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const client = createClient(
      UserService,
      createGrpcTransport({ baseUrl: `http://127.0.0.1:${port}` }),
    );
    expect((await client.getPublicKey({})).algorithm).toBe('RS256');
    await server.close();
    expect(server.server.listening).toBe(false);
  });

  it('listen rechaza si el puerto está ocupado', async () => {
    const a = createGrpcServer(() => {});
    await a.listen(0, '127.0.0.1');
    const address = a.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const b = createGrpcServer(() => {});
    await expect(b.listen(port, '127.0.0.1')).rejects.toThrow(/EADDRINUSE/);
    await a.close();
  });
});

describe('ensureAdmin', () => {
  const admin = { username: 'admin', email: 'Admin@Juez.local', password: 'admin-password' };

  it('crea el ADMIN una sola vez (idempotente)', async () => {
    const repo = new InMemoryUsersRepository();
    const { logger } = memoryLogger();
    expect(await ensureAdmin({ repo, logger, hash: fakeHash }, admin)).toBe('created');
    expect(await ensureAdmin({ repo, logger, hash: fakeHash }, admin)).toBe('exists');
    expect(repo.users).toHaveLength(1);
    expect(repo.users[0]).toMatchObject({ role: 'ADMIN', email: 'admin@juez.local' });
    expect(repo.events).toHaveLength(1);
  });

  it('no modifica un usuario existente con el mismo username', async () => {
    const repo = new InMemoryUsersRepository();
    await repo.createWithRegisteredEvent({
      username: 'admin',
      email: 'x@x.com',
      passwordHash: 'h',
      role: 'CONTESTANT',
    });
    expect(await ensureAdmin({ repo, logger: silentLogger, hash: fakeHash }, admin)).toBe('exists');
    expect(repo.users[0]?.role).toBe('CONTESTANT');
  });

  it('se omite sin configuración y falla con datos inválidos', async () => {
    const repo = new InMemoryUsersRepository();
    expect(await ensureAdmin({ repo, logger: silentLogger }, undefined)).toBe('skipped');
    await expect(
      ensureAdmin({ repo, logger: silentLogger, hash: fakeHash }, { ...admin, password: 'corta' }),
    ).rejects.toThrow(/USERS_ADMIN_\* inválidas/);
  });

  it('propaga errores inesperados del repositorio', async () => {
    const repo = new InMemoryUsersRepository();
    repo.createWithRegisteredEvent = async () => {
      throw new Error('BD caída');
    };
    await expect(
      ensureAdmin({ repo, logger: silentLogger, hash: fakeHash }, admin),
    ).rejects.toThrow('BD caída');
  });
});

describe('DrizzleUsersRepository', () => {
  const row = {
    id: '00000000-0000-4000-8000-000000000001',
    username: 'ada',
    email: 'ada@x.com',
    passwordHash: 'h',
    role: 'CONTESTANT' as const,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('inserta usuario y evento user.registered en la misma transacción', async () => {
    const { chain, calls } = chainFake([[row], undefined]);
    let transactions = 0;
    const db = {
      transaction: (fn: (tx: unknown) => unknown) => {
        transactions++;
        return fn(chain);
      },
    };
    const user = await new DrizzleUsersRepository(db as never).createWithRegisteredEvent({
      username: 'ada',
      email: 'ada@x.com',
      passwordHash: 'h',
      role: 'CONTESTANT',
    });
    expect(transactions).toBe(1);
    expect(user).toMatchObject({ id: row.id, username: 'ada', role: 'CONTESTANT' });
    const outboxValues = calls.filter((c) => c.method === 'values')[1]?.args[0] as Record<
      string,
      unknown
    >;
    expect(outboxValues).toMatchObject({
      topic: 'user.registered',
      messageKey: row.id,
      headers: {
        'content-type': 'application/x-protobuf',
        'event-type': 'juez.events.v1.UserRegistered',
      },
    });
    expect(Buffer.isBuffer(outboxValues.payload)).toBe(true);
  });

  it.each([
    ['users_username_lower_key', 'username'],
    ['users_email_key', 'email'],
  ])('traduce la violación de %s a DuplicateUserError(%s)', async (constraint, field) => {
    const pgError = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint_name: constraint,
    });
    const db = {
      transaction: async () => {
        throw Object.assign(new Error('Failed query'), { cause: pgError });
      },
    };
    const err = await new DrizzleUsersRepository(db as never)
      .createWithRegisteredEvent({
        username: 'a',
        email: 'a@a.com',
        passwordHash: 'h',
        role: 'ADMIN',
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DuplicateUserError);
    expect((err as DuplicateUserError).field).toBe(field);
  });

  it('propaga otros errores', async () => {
    const db = {
      transaction: async () => {
        throw new Error('conexión perdida');
      },
    };
    await expect(
      new DrizzleUsersRepository(db as never).createWithRegisteredEvent({
        username: 'a',
        email: 'a@a.com',
        passwordHash: 'h',
        role: 'ADMIN',
      }),
    ).rejects.toThrow('conexión perdida');
  });

  it('consultas: findByLogin normaliza, findById/findByIds mapean filas', async () => {
    const { chain, calls } = chainFake([[row], [], [row], [row]]);
    const repo = new DrizzleUsersRepository({ select: () => chain } as never);
    expect((await repo.findByLogin('  ADA '))?.id).toBe(row.id);
    expect(await repo.findById(row.id)).toBeUndefined();
    expect((await repo.findById(row.id))?.username).toBe('ada');
    expect(await repo.findByIds([row.id])).toHaveLength(1);
    expect(await repo.findByIds([])).toEqual([]);
    expect(calls.filter((c) => c.method === 'limit').map((c) => c.args[0])).toEqual([1, 1, 1]);
  });
});

describe('BD y migraciones', () => {
  it('findUniqueViolation recorre la cadena de cause', () => {
    expect(findUniqueViolation({ code: '23505', constraint_name: 'x' })).toEqual({
      constraint: 'x',
    });
    expect(findUniqueViolation({ cause: { cause: { code: '23505' } } })).toEqual({
      constraint: undefined,
    });
    expect(findUniqueViolation(new Error('otro'))).toBeUndefined();
    expect(findUniqueViolation(undefined)).toBeUndefined();
  });

  it('el journal de migraciones referencia archivos existentes y ordenados', () => {
    const journal = JSON.parse(
      readFileSync(join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'),
    ) as {
      entries: { idx: number; tag: string; when: number }[];
    };
    journal.entries.forEach((e, i) => {
      expect(e.idx).toBe(i);
      expect(existsSync(join(MIGRATIONS_DIR, `${e.tag}.sql`))).toBe(true);
      if (i > 0) expect(e.when).toBeGreaterThan(journal.entries[i - 1]!.when);
    });
  });

  it('ping falla con timeout si la BD no responde', async () => {
    const db = createDatabase('postgres://u:p@127.0.0.1:1/x', { max: 1 });
    await expect(db.ping(200)).rejects.toThrow();
    await db.close();
  });
});
