import { Redis } from 'ioredis';
import type { Logger } from '../logger.js';
import { backoffDelay } from '../backoff.js';

export type RedisCommand = [string, ...(string | number)[]];

/** Subconjunto de Redis que usa la proyección (permite un fake en memoria en los tests). */
export interface RedisLike {
  exists(key: string): Promise<number>;
  zcard(key: string): Promise<number>;
  /** ZREVRANGE key start stop WITHSCORES -> [member, score, member, score…] */
  zrevrangeWithScores(key: string, start: number, stop: number): Promise<string[]>;
  zcount(key: string, min: string, max: string): Promise<number>;
  hmget(key: string, fields: string[]): Promise<(string | null)[]>;
  hgetall(key: string): Promise<Record<string, string>>;
  hget(key: string, field: string): Promise<string | null>;
  ping(): Promise<unknown>;
  /** MULTI … EXEC: todos los comandos se aplican de forma atómica. Lanza si alguno falla. */
  transaction(commands: RedisCommand[]): Promise<void>;
}

/**
 * Cliente ioredis que arranca aunque Redis no esté disponible y reconecta en segundo plano
 * con backoff exponencial (tope 30 s). Sin cola offline: mientras está desconectado los
 * comandos fallan de inmediato (la proyección queda degradada y GetScoreboard usa Postgres).
 */
export function createRedis(url: string, logger: Logger): Redis {
  const redis = new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 2_000,
    connectTimeout: 5_000,
    retryStrategy: (times) => backoffDelay(times - 1, 250),
  });
  const log = logger.child({ component: 'redis' });
  let wasReady = false;
  redis.on('ready', () => {
    wasReady = true;
    log.info('redis conectado');
  });
  redis.on('error', (err: Error) => log.warn({ err: err.message }, 'error de redis'));
  redis.on('end', () => {
    if (wasReady) log.info('conexión con redis cerrada');
  });
  // connect() rechaza si el primer intento falla, pero ioredis sigue reintentando solo.
  redis.connect().catch(() => {});
  return redis;
}

export function ioredisAdapter(redis: Redis): RedisLike {
  return {
    exists: (key) => redis.exists(key),
    zcard: (key) => redis.zcard(key),
    zrevrangeWithScores: (key, start, stop) => redis.zrevrange(key, start, stop, 'WITHSCORES'),
    zcount: (key, min, max) => redis.zcount(key, min, max),
    hmget: (key, fields) => (fields.length ? redis.hmget(key, ...fields) : Promise.resolve([])),
    hgetall: (key) => redis.hgetall(key),
    hget: (key, field) => redis.hget(key, field),
    ping: () => redis.ping(),
    async transaction(commands) {
      const results = await redis.multi(commands).exec();
      if (!results) throw new Error('transacción de redis abortada');
      const failed = results.find(([err]) => err);
      if (failed) throw failed[0];
    },
  };
}
