import { generateKeyPairSync } from 'node:crypto';
import { Writable } from 'node:stream';
import { keysFromPem } from '../src/auth/keys.js';
import type { SigningKeys } from '../src/auth/keys.js';
import { TokenService } from '../src/auth/tokens.js';
import { createLogger } from '../src/logger.js';
import type { Logger } from '../src/logger.js';
import { DuplicateUserError } from '../src/repository.js';
import type { NewUser, UserRecord, UsersRepository } from '../src/repository.js';

let cachedKeys: { privatePem: string; publicPem: string } | undefined;

/** Par RSA 2048 en PEM (se genera una vez por archivo de test). */
export function rsaPem() {
  cachedKeys ??= (() => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    return {
      privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    };
  })();
  return cachedKeys;
}

export function testKeys(): SigningKeys {
  const { privatePem, publicPem } = rsaPem();
  return keysFromPem(privatePem, publicPem);
}

export function testTokens(overrides: Partial<ConstructorParameters<typeof TokenService>[0]> = {}) {
  return new TokenService({
    keys: testKeys(),
    keyId: 'test-1',
    issuer: 'juez-users',
    audience: 'juez',
    ttlSeconds: 3600,
    ...overrides,
  });
}

/** Logger que acumula las líneas JSON en memoria. */
export function memoryLogger(level = 'trace'): {
  logger: Logger;
  lines: () => Record<string, unknown>[];
} {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return {
    logger: createLogger(level, stream),
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

export const silentLogger = createLogger('silent');

/** Hash rápido y determinista para tests (no usar scrypt real en cada caso). */
export const fakeHash = async (password: string) => `fake$${password}`;
export const fakeVerify = async (password: string, hash: string) => hash === `fake$${password}`;

/** Repositorio en memoria con las mismas reglas de unicidad que la BD. */
export class InMemoryUsersRepository implements UsersRepository {
  readonly users: UserRecord[] = [];
  readonly events: { userId: string; username: string }[] = [];
  private seq = 0;

  async createWithRegisteredEvent(input: NewUser): Promise<UserRecord> {
    if (this.users.some((u) => u.username.toLowerCase() === input.username.toLowerCase())) {
      throw new DuplicateUserError('username');
    }
    if (this.users.some((u) => u.email === input.email)) throw new DuplicateUserError('email');
    const n = ++this.seq;
    const user: UserRecord = {
      ...input,
      id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      createdAt: new Date(Date.UTC(2026, 10, 11, 12, 0, n)),
    };
    this.users.push(user);
    this.events.push({ userId: user.id, username: user.username });
    return user;
  }

  async findByLogin(value: string) {
    const v = value.trim().toLowerCase();
    return this.users.find((u) => u.username.toLowerCase() === v || u.email === v);
  }

  async findById(id: string) {
    return this.users.find((u) => u.id === id);
  }

  async findByIds(ids: readonly string[]) {
    return this.users.filter((u) => ids.includes(u.id));
  }
}

/**
 * Fake de un query builder encadenable (drizzle): cualquier método devuelve la cadena y
 * cada `await` entrega el siguiente valor de `results`. Registra las llamadas.
 */
export function chainFake(results: unknown[]) {
  const calls: { method: string; args: unknown[] }[] = [];
  const queue = [...results];
  const proxy: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') {
        const next = queue.shift();
        return (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
          next instanceof Error ? reject(next) : resolve(next);
      }
      return (...args: unknown[]) => {
        calls.push({ method: String(prop), args });
        return proxy;
      };
    },
  });
  return { chain: proxy as never, calls };
}
