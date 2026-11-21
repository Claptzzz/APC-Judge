import { createClient } from '@connectrpc/connect';
import type { Client } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { UserService } from '@juez/contracts/es';
import { errors as joseErrors, importSPKI, jwtVerify } from 'jose';
import type { CryptoKey } from 'jose';
import type { Logger } from '../logger.js';
import { DEFAULT_UPSTREAM_TIMEOUT_MS } from '../upstream/clients.js';

export type Role = 'CONTESTANT' | 'SETTER' | 'ADMIN';

export interface TokenClaims {
  sub: string;
  username: string;
  role: Role;
}

/** El token falta o es inválido (formato, firma, iss/aud, expiración, claims): HTTP 401. */
export class InvalidTokenError extends Error {
  override name = 'InvalidTokenError';
}

/** No se pudo obtener la llave pública de users: no es culpa del token (HTTP 503). */
export class PublicKeyUnavailableError extends Error {
  override name = 'PublicKeyUnavailableError';
}

export interface JwtVerifierOptions {
  issuer: string;
  audience: string;
  logger: Logger;
  /** Timeout de GetPublicKey. */
  timeoutMs?: number;
  /** Backoff de los reintentos en segundo plano (1 s, 2 s, 4 s… tope 30 s). */
  initialRetryMs?: number;
  maxRetryMs?: number;
}

export type UsersKeyClient = Pick<Client<typeof UserService>, 'getPublicKey'>;

export function createUsersKeyClient(baseUrl: string): UsersKeyClient {
  return createClient(UserService, createGrpcTransport({ baseUrl }));
}

/** Backoff exponencial: initial · 2^attempt, con tope en max. */
export function backoffDelay(attempt: number, initialMs: number, maxMs: number): number {
  return Math.min(initialMs * 2 ** attempt, maxMs);
}

const ROLES: readonly string[] = ['CONTESTANT', 'SETTER', 'ADMIN'];

/**
 * Verifica JWT RS256 localmente con la llave pública de users (GetPublicKey), cacheada.
 * Si users no responde al arrancar, reintenta en segundo plano con backoff y también al
 * verificar cada token, hasta tener la llave.
 */
export class JwtVerifier {
  private publicKey: CryptoKey | undefined;
  private algorithm = 'RS256';
  private inflight: Promise<void> | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private attempt = 0;
  private stopped = false;
  private readonly timeoutMs: number;
  private readonly initialRetryMs: number;
  private readonly maxRetryMs: number;

  constructor(
    private readonly users: UsersKeyClient,
    private readonly opts: JwtVerifierOptions,
  ) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
    this.initialRetryMs = opts.initialRetryMs ?? 1_000;
    this.maxRetryMs = opts.maxRetryMs ?? 30_000;
  }

  /** /ready: la llave pública está cargada. */
  hasPublicKey(): boolean {
    return this.publicKey !== undefined;
  }

  /** Intenta cachear la llave. Nunca rechaza: si falla, reintenta en segundo plano. */
  async init(): Promise<void> {
    this.stopped = false;
    try {
      await this.fetchPublicKey();
    } catch (err) {
      this.opts.logger.warn(
        { err },
        'no se pudo obtener la llave pública de users; se reintentará',
      );
      this.scheduleRetry();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  async verify(token: string): Promise<TokenClaims> {
    if (!this.publicKey) {
      try {
        await this.fetchPublicKey();
      } catch (err) {
        throw new PublicKeyUnavailableError('Llave pública de users no disponible', {
          cause: err,
        });
      }
    }
    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.publicKey!, {
        algorithms: [this.algorithm],
        issuer: this.opts.issuer,
        audience: this.opts.audience,
      }));
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) throw new InvalidTokenError('Token expirado');
      throw new InvalidTokenError('Token inválido');
    }
    const { sub, username, role } = payload;
    if (
      typeof sub !== 'string' ||
      !sub ||
      typeof username !== 'string' ||
      typeof role !== 'string' ||
      !ROLES.includes(role)
    ) {
      throw new InvalidTokenError('Claims inválidos');
    }
    return { sub, username, role: role as Role };
  }

  /** GetPublicKey con timeout; las llamadas concurrentes comparten la misma petición. */
  private fetchPublicKey(): Promise<void> {
    if (this.publicKey) return Promise.resolve();
    this.inflight ??= (async () => {
      try {
        const res = await this.users.getPublicKey({}, { timeoutMs: this.timeoutMs });
        const algorithm = res.algorithm || 'RS256';
        this.publicKey = await importSPKI(res.publicKeyPem, algorithm);
        this.algorithm = algorithm;
        this.attempt = 0;
        this.opts.logger.info({ keyId: res.keyId }, 'llave pública de users cacheada');
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer || this.publicKey) return;
    const delayMs = backoffDelay(this.attempt, this.initialRetryMs, this.maxRetryMs);
    this.attempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.init();
    }, delayMs);
    this.retryTimer.unref();
  }
}

/** `Authorization: Bearer <jwt>` → jwt. Lanza InvalidTokenError si falta o el formato es otro. */
export function extractBearerToken(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new InvalidTokenError('Falta el header Authorization: Bearer <jwt>');
  const match = /^Bearer\s+(\S+)\s*$/i.exec(value);
  if (!match?.[1]) {
    throw new InvalidTokenError('Formato de Authorization inválido (debe ser Bearer <jwt>)');
  }
  return match[1];
}
