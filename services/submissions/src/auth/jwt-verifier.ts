import { createClient } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { AUTH_METADATA_KEY } from '@juez/contracts';
import { UserService } from '@juez/contracts/es';
import { errors as joseErrors, importSPKI, jwtVerify, type CryptoKey } from 'jose';
import { backoffDelay, DEFAULT_INITIAL_RETRY_MS, DEFAULT_MAX_RETRY_MS } from '../backoff.js';
import { DEFAULT_UPSTREAM_TIMEOUT_MS } from '../clients/errors.js';
import type { Logger } from '../logger.js';

export interface TokenClaims {
  sub: string;
  username: string;
  role: 'CONTESTANT' | 'SETTER' | 'ADMIN';
}

/** El token es inválido (formato, firma, expiración, claims): UNAUTHENTICATED. */
export class InvalidTokenError extends Error {
  override name = 'InvalidTokenError';
}

/**
 * No se pudo obtener la llave pública de users. No es culpa del token: el controlador lo
 * traduce a UNAVAILABLE / INTERNAL según la causa (`cause`).
 */
export class PublicKeyUnavailableError extends Error {
  override name = 'PublicKeyUnavailableError';
}

export interface JwtVerifierOptions {
  /** Timeout de GetPublicKey. */
  timeoutMs?: number;
  /** Backoff de los reintentos en segundo plano si users no responde al arrancar. */
  initialRetryMs?: number;
  maxRetryMs?: number;
}

export class JwtVerifier {
  private publicKey: CryptoKey | undefined;
  private algorithm = 'RS256';
  private readonly client: ReturnType<typeof createClient<typeof UserService>>;
  private readonly timeoutMs: number;
  private readonly initialRetryMs: number;
  private readonly maxRetryMs: number;
  private inflight: Promise<void> | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private attempt = 0;
  private stopped = false;

  constructor(
    usersGrpcAddr: string,
    private readonly issuer: string,
    private readonly audience: string,
    private readonly logger: Logger,
    opts: JwtVerifierOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
    this.initialRetryMs = opts.initialRetryMs ?? DEFAULT_INITIAL_RETRY_MS;
    this.maxRetryMs = opts.maxRetryMs ?? DEFAULT_MAX_RETRY_MS;
    this.client = createClient(
      UserService,
      createGrpcTransport({ baseUrl: `http://${usersGrpcAddr}` }),
    );
  }

  hasPublicKey(): boolean {
    return this.publicKey !== undefined;
  }

  /**
   * Intenta cachear la llave pública. Nunca rechaza: si users no responde, reintenta en
   * segundo plano con backoff exponencial (tope `maxRetryMs`) hasta obtenerla o hasta `stop()`.
   */
  async init(): Promise<void> {
    this.stopped = false;
    try {
      await this.fetchPublicKey();
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
    if (!this.publicKey) {
      try {
        await this.fetchPublicKey();
      } catch (err) {
        throw new PublicKeyUnavailableError('Llave pública de users no disponible', {
          cause: err,
        });
      }
    }
    try {
      const { payload } = await jwtVerify(token, this.publicKey!, {
        algorithms: [this.algorithm],
        issuer: this.issuer,
        audience: this.audience,
      });
      const { sub, username, role } = payload;
      if (
        typeof sub !== 'string' ||
        typeof username !== 'string' ||
        typeof role !== 'string' ||
        !['CONTESTANT', 'SETTER', 'ADMIN'].includes(role)
      ) {
        throw new InvalidTokenError('Claims inválidos');
      }
      return { sub, username, role: role as TokenClaims['role'] };
    } catch (err) {
      if (err instanceof InvalidTokenError) throw err;
      if (err instanceof joseErrors.JWTExpired) throw new InvalidTokenError('Token expirado');
      throw new InvalidTokenError('Token inválido');
    }
  }

  /** GetPublicKey con timeout; las llamadas concurrentes comparten la misma petición. */
  private fetchPublicKey(): Promise<void> {
    if (this.publicKey) return Promise.resolve();
    this.inflight ??= (async () => {
      try {
        const res = await this.client.getPublicKey({}, { timeoutMs: this.timeoutMs });
        const algorithm = res.algorithm || 'RS256';
        this.publicKey = await importSPKI(res.publicKeyPem, algorithm);
        this.algorithm = algorithm;
        this.attempt = 0;
        this.logger.info({ keyId: res.keyId }, 'llave pública de users cacheada');
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

export function extractBearerToken(metadata?: { get(key: string): unknown }): string {
  if (!metadata) throw new InvalidTokenError('Falta la metadata de autorización');
  const raw = metadata.get(AUTH_METADATA_KEY);
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || typeof value !== 'string') {
    throw new InvalidTokenError('Falta el token de acceso');
  }
  const match = /^Bearer\s+(\S+)$/i.exec(value.trim());
  if (!match?.[1]) {
    throw new InvalidTokenError('Formato de authorization inválido (debe ser Bearer <token>)');
  }
  return match[1];
}
