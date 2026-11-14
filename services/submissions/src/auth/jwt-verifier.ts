import { createClient } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { AUTH_METADATA_KEY } from '@juez/contracts';
import { UserService } from '@juez/contracts/es';
import { errors as joseErrors, importSPKI, jwtVerify, type CryptoKey } from 'jose';
import type { Logger } from '../logger.js';

export interface TokenClaims {
  sub: string;
  username: string;
  role: 'CONTESTANT' | 'SETTER' | 'ADMIN';
}

export class InvalidTokenError extends Error {
  override name = 'InvalidTokenError';
}

export class JwtVerifier {
  private publicKey: CryptoKey | undefined;
  private algorithm = 'RS256';

  constructor(
    private readonly usersGrpcAddr: string,
    private readonly issuer: string,
    private readonly audience: string,
    private readonly logger: Logger,
  ) {}

  async init(): Promise<void> {
    try {
      const transport = createGrpcTransport({
        baseUrl: `http://${this.usersGrpcAddr}`,
      });
      const client = createClient(UserService, transport);
      const res = await client.getPublicKey({});
      this.publicKey = await importSPKI(res.publicKeyPem, res.algorithm || 'RS256');
      this.algorithm = res.algorithm || 'RS256';
      this.logger.info({ keyId: res.keyId }, 'llave pública de users cacheada');
    } catch (err) {
      this.logger.warn(
        { err },
        'no se pudo obtener la llave pública de users al arrancar; se reintentará en la primera petición',
      );
    }
  }

  async verify(token: string): Promise<TokenClaims> {
    if (!this.publicKey) {
      await this.init();
      if (!this.publicKey) {
        throw new InvalidTokenError('Llave pública de users no disponible');
      }
    }
    try {
      const { payload } = await jwtVerify(token, this.publicKey, {
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
