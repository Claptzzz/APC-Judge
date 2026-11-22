import { randomUUID } from 'node:crypto';
import { decodeProtectedHeader, errors as joseErrors, importSPKI, jwtVerify } from 'jose';
import type { CryptoKey } from 'jose';
import { backoffDelay, DEFAULT_INITIAL_RETRY_MS, DEFAULT_MAX_RETRY_MS } from '../backoff.js';
import type { Backend } from '../grpc/backend.js';
import type { Logger } from '../logger.js';

export type Role = 'CONTESTANT' | 'SETTER' | 'ADMIN';

export interface TokenClaims {
  sub: string;
  username: string;
  role: Role;
}

/** El token es inválido (formato, firma, expiración, claims): UNAUTHENTICATED. */
export class InvalidTokenError extends Error {
  override name = 'InvalidTokenError';
}

/** No se pudo obtener la llave pública de users: UNAVAILABLE (no es culpa del token). */
export class PublicKeyUnavailableError extends Error {
  override name = 'PublicKeyUnavailableError';
}

export interface JwtVerifierOptions {
  initialRetryMs?: number;
  maxRetryMs?: number;
  /** Intervalo mínimo entre refrescos de la llave por un `kid` desconocido. */
  minRefreshIntervalMs?: number;
}

const ROLES: readonly string[] = ['CONTESTANT', 'SETTER', 'ADMIN'];

interface CachedKey {
  key: CryptoKey;
  keyId: string;
  algorithm: string;
}

/**
 * Verifica JWT RS256 localmente con la llave de `UserService.GetPublicKey`. Al arrancar la
 * pide sin bloquear y, si users no responde, reintenta en segundo plano con backoff
 * exponencial (tope 30 s). Si llega un token con un `kid` distinto al cacheado, refresca la
 * llave (como mucho una vez por `minRefreshIntervalMs`).
 */
export class JwtVerifier {
  private cached: CachedKey | undefined;
  private inflight: Promise<CachedKey> | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private attempt = 0;
  private stopped = false;
  private lastRefreshAt = 0;
  private readonly initialRetryMs: number;
  private readonly maxRetryMs: number;
  private readonly minRefreshIntervalMs: number;

  constructor(
    private readonly users: Pick<Backend['users'], 'getPublicKey'>,
    private readonly issuer: string,
    private readonly audience: string,
    private readonly logger: Logger,
    opts: JwtVerifierOptions = {},
  ) {
    this.initialRetryMs = opts.initialRetryMs ?? DEFAULT_INITIAL_RETRY_MS;
    this.maxRetryMs = opts.maxRetryMs ?? DEFAULT_MAX_RETRY_MS;
    this.minRefreshIntervalMs = opts.minRefreshIntervalMs ?? 10_000;
  }

  hasPublicKey(): boolean {
    return this.cached !== undefined;
  }

  /** Nunca rechaza: si users no responde, programa reintentos con backoff. */
  async init(): Promise<void> {
    this.stopped = false;
    try {
      await this.fetchKey();
    } catch (err) {
      this.logger.warn({ err }, 'no se pudo obtener la llave pública de users; se reintentará');
      this.scheduleRetry();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  async verify(token: string): Promise<TokenClaims> {
    let kid: string | undefined;
    try {
      kid = decodeProtectedHeader(token).kid;
    } catch {
      throw new InvalidTokenError('Token inválido');
    }

    let key = await this.currentKey();
    if (kid && kid !== key.keyId && Date.now() - this.lastRefreshAt >= this.minRefreshIntervalMs) {
      // Puede que users haya rotado la llave: se pide de nuevo antes de rechazar el token.
      this.logger.info({ kid, cachedKid: key.keyId }, 'kid desconocido; refrescando la llave');
      try {
        key = await this.fetchKey(true);
      } catch (err) {
        // Se mantiene la llave anterior: el token se verifica con ella (y probablemente falla).
        this.logger.warn({ err }, 'no se pudo refrescar la llave pública de users');
      }
    }

    try {
      const { payload } = await jwtVerify(token, key.key, {
        algorithms: [key.algorithm],
        issuer: this.issuer,
        audience: this.audience,
      });
      const { sub, username, role } = payload;
      if (
        typeof sub !== 'string' ||
        typeof username !== 'string' ||
        typeof role !== 'string' ||
        !ROLES.includes(role)
      ) {
        throw new InvalidTokenError('Claims inválidos');
      }
      return { sub, username, role: role as Role };
    } catch (err) {
      if (err instanceof InvalidTokenError) throw err;
      if (err instanceof joseErrors.JWTExpired) throw new InvalidTokenError('Token expirado');
      throw new InvalidTokenError('Token inválido');
    }
  }

  private async currentKey(): Promise<CachedKey> {
    if (this.cached) return this.cached;
    try {
      return await this.fetchKey();
    } catch (err) {
      throw new PublicKeyUnavailableError('Llave pública de users no disponible', { cause: err });
    }
  }

  /** GetPublicKey; las llamadas concurrentes comparten la misma petición. */
  private fetchKey(force = false): Promise<CachedKey> {
    if (this.cached && !force) return Promise.resolve(this.cached);
    this.inflight ??= (async () => {
      try {
        this.lastRefreshAt = Date.now();
        const res = await this.users.getPublicKey({}, { requestId: randomUUID() });
        const algorithm = res.algorithm || 'RS256';
        const cached: CachedKey = {
          key: await importSPKI(res.publicKeyPem, algorithm),
          keyId: res.keyId,
          algorithm,
        };
        this.cached = cached;
        this.attempt = 0;
        this.logger.info({ keyId: res.keyId }, 'llave pública de users cacheada');
        return cached;
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer || this.cached) return;
    const delayMs = backoffDelay(this.attempt, this.initialRetryMs, this.maxRetryMs);
    this.attempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.init();
    }, delayMs);
    this.retryTimer.unref();
  }
}

/** `Bearer <jwt>` → `<jwt>`; `undefined` si no viene; lanza si el formato es inválido. */
export function parseBearer(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') throw new InvalidTokenError('Authorization inválido');
  const match = /^Bearer\s+(\S+)$/i.exec(raw.trim());
  if (!match?.[1]) {
    throw new InvalidTokenError('Formato de Authorization inválido (debe ser Bearer <token>)');
  }
  return match[1];
}
