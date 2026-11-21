import { Code, ConnectError, createClient, createRouterTransport } from '@connectrpc/connect';
import { RankingService } from '@juez/contracts/es';
import { describe, expect, it, vi } from 'vitest';
import { backoffDelay } from '../../src/backoff.js';
import { ConfigError, loadConfig, toBaseUrl } from '../../src/config.js';
import { createHttpApp } from '../../src/http/app.js';
import {
  codeName,
  requestContextInterceptor,
  resolveRequestId,
} from '../../src/grpc/interceptors.js';
import { createGrpcServer } from '../../src/grpc/server.js';
import { decodeContestCursor, encodeContestCursor, pageSize } from '../../src/grpc/pagination.js';
import { createMetrics } from '../../src/metrics.js';
import { ioredisAdapter } from '../../src/projection/redis.js';
import { memoryLogger, uuid } from '../helpers.js';

const baseEnv = {
  RANKING_DATABASE_URL: 'postgres://u:p@localhost:5432/ranking',
  RANKING_REDIS_URL: 'redis://localhost:6379/0',
  KAFKA_BROKERS: 'localhost:9092, other:9092',
  USERS_GRPC_ADDR: 'localhost:50051',
  PROBLEMS_GRPC_ADDR: 'http://problems:50052',
};

describe('config', () => {
  it('carga valores por defecto y normaliza direcciones', () => {
    const c = loadConfig(baseEnv);
    expect(c).toMatchObject({
      httpPort: 8084,
      grpcPort: 50054,
      kafka: { brokers: ['localhost:9092', 'other:9092'], clientId: 'ranking', groupId: 'ranking' },
      usersBaseUrl: 'http://localhost:50051',
      problemsBaseUrl: 'http://problems:50052',
      jwt: { issuer: 'juez-users', audience: 'juez' },
    });
    expect(toBaseUrl('h:1')).toBe('http://h:1');
  });

  it('reporta todas las variables inválidas', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    try {
      loadConfig({ ...baseEnv, RANKING_REDIS_URL: 'http://x', RANKING_HTTP_PORT: '99999' });
    } catch (err) {
      expect((err as ConfigError).issues.join()).toMatch(
        /RANKING_REDIS_URL.*RANKING_HTTP_PORT|RANKING_HTTP_PORT.*RANKING_REDIS_URL/,
      );
    }
    expect(() => loadConfig({ ...baseEnv, KAFKA_BROKERS: ' , ' })).toThrow(/sin brokers/);
  });
});

describe('backoff', () => {
  it('es exponencial con tope de 30 s', () => {
    expect([0, 1, 2, 3].map((a) => backoffDelay(a))).toEqual([1000, 2000, 4000, 8000]);
    expect(backoffDelay(20)).toBe(30_000);
  });
});

describe('paginación', () => {
  it('cursor de contests ida y vuelta', () => {
    const c = { startTime: new Date('2026-01-01T00:00:00.123Z'), id: uuid(1) };
    expect(decodeContestCursor(encodeContestCursor(c))).toEqual(c);
    expect(decodeContestCursor('')).toBeUndefined();
    expect(pageSize(0, 20, 100)).toBe(20);
    expect(pageSize(500, 20, 100)).toBe(100);
  });
});

describe('HTTP (Hono)', () => {
  const registry = createMetrics({ defaultMetrics: false }).registry;

  it('/health responde 200', async () => {
    const app = createHttpApp({ registry, readiness: {} });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect((await app.request('/nope')).status).toBe(404);
  });

  it('/ready 503 si falla una dependencia obligatoria', async () => {
    const app = createHttpApp({
      registry,
      readiness: {
        database: async () => {},
        kafkaConsumer: () => {
          throw new Error('consumidor no unido al grupo');
        },
      },
    });
    const res = await app.request('/ready');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      status: 'not_ready',
      checks: {
        database: { status: 'ok' },
        kafkaConsumer: { status: 'down', error: 'consumidor no unido al grupo' },
      },
    });
  });

  it('/ready 200 "degraded" si Redis o la proyección están degradados', async () => {
    const app = createHttpApp({
      registry,
      readiness: { database: () => undefined },
      degradable: {
        redis: async () => {
          throw new Error('ECONNREFUSED');
        },
        projection: () => ({ status: 'degraded', dirtyContests: ['c1'] }),
      },
    });
    const res = await app.request('/ready');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: 'degraded',
      checks: {
        redis: { status: 'degraded', error: 'ECONNREFUSED' },
        projection: { status: 'degraded', dirtyContests: ['c1'] },
      },
    });
  });

  it('/ready 200 "ready" con todo OK y /metrics en formato Prometheus', async () => {
    const metrics = createMetrics({ defaultMetrics: false });
    metrics.eventsProcessed.inc({ topic: 't', status: 'processed' });
    const app = createHttpApp({
      registry: metrics.registry,
      readiness: { database: () => undefined },
      degradable: { redis: () => ({ status: 'ok' }) },
    });
    expect(await (await app.request('/ready')).json()).toMatchObject({ status: 'ready' });
    const res = await app.request('/metrics');
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toContain('kafka_events_processed_total');
  });
});

describe('interceptor gRPC', () => {
  function client(handler: () => Promise<never>, logger = memoryLogger()) {
    const transport = createRouterTransport(
      ({ service }) =>
        service(RankingService, {
          getUserStats: handler,
        }),
      {
        router: {
          interceptors: [
            requestContextInterceptor(logger.logger, createMetrics({ defaultMetrics: false })),
          ],
        },
      },
    );
    return { c: createClient(RankingService, transport), logger };
  }

  it('propaga x-request-id y registra el código de error', async () => {
    const { c, logger } = client(async () => {
      throw new ConnectError('nope', Code.NotFound);
    });
    const err = await c.getUserStats({}, { headers: { 'x-request-id': 'abc-1' } }).then(
      () => undefined,
      (e: unknown) => ConnectError.from(e),
    );
    expect(err?.metadata.get('x-request-id')).toBe('abc-1');
    expect(logger.lines().at(-1)).toMatchObject({
      requestId: 'abc-1',
      code: 'not_found',
      rpc: 'GetUserStats',
    });
  });

  it('genera un request id si el entrante no es válido y registra unavailable como error', async () => {
    const { c, logger } = client(async () => {
      throw new ConnectError('caído', Code.Unavailable);
    });
    const err = await c.getUserStats({}, { headers: { 'x-request-id': 'bad id!' } }).then(
      () => undefined,
      (e: unknown) => ConnectError.from(e),
    );
    expect(err?.metadata.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(logger.lines().at(-1)).toMatchObject({ level: 'error', code: 'unavailable' });
  });

  it('helpers', () => {
    expect(codeName(Code.InvalidArgument)).toBe('invalid_argument');
    expect(codeName(999 as Code)).toBe('unknown');
    expect(resolveRequestId(null)).toMatch(/-/);
  });
});

describe('servidor gRPC HTTP/2', () => {
  it('escucha en un puerto efímero y cierra', async () => {
    const server = createGrpcServer(() => {});
    const port = await server.listen(0, '127.0.0.1');
    expect(port).toBeGreaterThan(0);
    await server.close();
    await server.close(); // idempotente
  });
});

describe('ioredisAdapter', () => {
  it('traduce las llamadas y propaga errores de la transacción', async () => {
    const exec = vi.fn();
    const fake = {
      exists: vi.fn(async () => 1),
      zcard: vi.fn(async () => 2),
      zrevrange: vi.fn(async () => ['a', '1']),
      zcount: vi.fn(async () => 0),
      hmget: vi.fn(async () => ['x']),
      hgetall: vi.fn(async () => ({})),
      hget: vi.fn(async () => null),
      ping: vi.fn(async () => 'PONG'),
      multi: vi.fn(() => ({ exec })),
    };
    const r = ioredisAdapter(fake as never);
    expect(await r.exists('k')).toBe(1);
    expect(await r.zcard('k')).toBe(2);
    expect(await r.zrevrangeWithScores('k', 0, 1)).toEqual(['a', '1']);
    expect(fake.zrevrange).toHaveBeenCalledWith('k', 0, 1, 'WITHSCORES');
    expect(await r.zcount('k', '(1', '+inf')).toBe(0);
    expect(await r.hmget('k', [])).toEqual([]);
    expect(await r.hmget('k', ['f'])).toEqual(['x']);
    expect(await r.hgetall('k')).toEqual({});
    expect(await r.hget('k', 'f')).toBeNull();
    expect(await r.ping()).toBe('PONG');

    exec.mockResolvedValueOnce([[null, 1]]);
    await r.transaction([['del', 'k']]);
    expect(fake.multi).toHaveBeenCalledWith([['del', 'k']]);
    exec.mockResolvedValueOnce(null);
    await expect(r.transaction([])).rejects.toThrow(/abortada/);
    exec.mockResolvedValueOnce([[new Error('WRONGTYPE'), null]]);
    await expect(r.transaction([])).rejects.toThrow('WRONGTYPE');
  });
});
