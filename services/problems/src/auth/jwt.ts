import { Code, ConnectError, createClient } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { UserService } from '@juez/contracts/es';
import { decodeProtectedHeader, errors, importSPKI, jwtVerify, type CryptoKey } from 'jose';
import { z } from 'zod';
import type { Logger } from '../logger.js';

export const ROLES = ['CONTESTANT', 'SETTER', 'ADMIN'] as const;
export type Role = (typeof ROLES)[number];

export interface Principal {
  userId: string;
  username: string;
  role: Role;
}

export interface PublicKeyInfo {
  publicKeyPem: string;
  keyId: string;
  algorithm: string;
}

/** Origen de la llave pública (users.GetPublicKey en producción; un fake en tests). */
export type PublicKeySource = () => Promise<PublicKeyInfo>;

export function usersPublicKeySource(baseUrl: string, timeoutMs = 3_000): PublicKeySource {
  const client = createClient(UserService, createGrpcTransport({ baseUrl }));
  return async () => {
    const res = await client.getPublicKey({}, { timeoutMs });
    return { publicKeyPem: res.publicKeyPem, keyId: res.keyId, algorithm: res.algorithm };
  };
}

/**
 * Normaliza el claim `role`. users aún no fija el formato, así que se acepta el nombre corto
 * (`SETTER`), el del enum protobuf (`ROLE_SETTER`) o su valor numérico (2).
 */
export function parseRole(value: unknown): Role | undefined {
  if (typeof value === 'number') return ROLES[value - 1];
  if (typeof value !== 'string') return undefined;
  const name = value
    .trim()
    .toUpperCase()
    .replace(/^ROLE_/, '');
  return (ROLES as readonly string[]).includes(name) ? (name as Role) : undefined;
}

const claimsSchema = z.object({
  sub: z.uuid(),
  username: z.string().default(''),
  role: z.unknown().transform((v, ctx) => {
    const role = parseRole(v);
    if (!role) {
      ctx.addIssue({ code: 'custom', message: 'rol desconocido' });
      return z.NEVER;
    }
    return role;
  }),
});

export interface JwtVerifierOptions {
  issuer: string;
  audience: string;
  logger?: Logger;
  /** Espera mínima entre recargas de la llave por un `kid` desconocido. */
  refreshCooldownMs?: number;
  now?: () => number;
}

interface CachedKey {
  key: CryptoKey;
  keyId: string;
}

/** Verifica localmente JWT RS256 con la llave pública de users (cacheada). */
export class JwtVerifier {
  private cached: CachedKey | undefined;
  private inflight: Promise<CachedKey> | undefined;
  private lastFetchAt = Number.NEGATIVE_INFINITY;
  private readonly now: () => number;

  constructor(
    private readonly source: PublicKeySource,
    private readonly opts: JwtVerifierOptions,
  ) {
    this.now = opts.now ?? Date.now;
  }

  /** Carga la llave al arrancar; si users no responde se reintenta en la primera verificación. */
  async warmUp(): Promise<boolean> {
    try {
      await this.loadKey();
      return true;
    } catch (err) {
      this.opts.logger?.warn(
        { err },
        'no se pudo obtener la llave pública de users; se reintentará',
      );
      return false;
    }
  }

  get hasKey(): boolean {
    return this.cached !== undefined;
  }

  private loadKey(): Promise<CachedKey> {
    this.inflight ??= (async () => {
      this.lastFetchAt = this.now();
      const info = await this.source();
      if (info.algorithm && info.algorithm !== 'RS256') {
        throw new Error(`algoritmo de llave no soportado: ${info.algorithm}`);
      }
      const key = await importSPKI(info.publicKeyPem, 'RS256');
      this.cached = { key, keyId: info.keyId };
      this.opts.logger?.info({ kid: info.keyId }, 'llave pública de users cargada');
      return this.cached;
    })().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async keyFor(kid: string | undefined): Promise<CachedKey> {
    const cooldown = this.opts.refreshCooldownMs ?? 30_000;
    const stale =
      this.cached && kid && kid !== this.cached.keyId && this.now() - this.lastFetchAt >= cooldown;
    if (this.cached && !stale) return this.cached;
    try {
      return await this.loadKey();
    } catch (err) {
      if (this.cached) return this.cached;
      this.opts.logger?.error({ err }, 'no se pudo obtener la llave pública de users');
      throw new ConnectError(
        'no se pudo verificar el token: llave pública no disponible',
        Code.Unavailable,
      );
    }
  }

  async verify(token: string): Promise<Principal> {
    let kid: string | undefined;
    try {
      kid = decodeProtectedHeader(token).kid;
    } catch {
      throw new ConnectError('token inválido', Code.Unauthenticated);
    }
    const { key } = await this.keyFor(kid);
    try {
      const { payload } = await jwtVerify(token, key, {
        algorithms: ['RS256'],
        issuer: this.opts.issuer,
        audience: this.opts.audience,
        currentDate: new Date(this.now()),
      });
      const claims = claimsSchema.safeParse(payload);
      if (!claims.success)
        throw new ConnectError('token con claims inválidos', Code.Unauthenticated);
      return { userId: claims.data.sub, username: claims.data.username, role: claims.data.role };
    } catch (err) {
      if (err instanceof ConnectError) throw err;
      if (err instanceof errors.JWTExpired)
        throw new ConnectError('token expirado', Code.Unauthenticated);
      throw new ConnectError('token inválido', Code.Unauthenticated);
    }
  }
}

/** Extrae el token de `authorization: Bearer <jwt>`; undefined si no viene el header. */
export function bearerToken(header: string | null): string | undefined {
  if (header === null || header.trim() === '') return undefined;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  if (!match?.[1]) throw new ConnectError('header authorization mal formado', Code.Unauthenticated);
  return match[1];
}
