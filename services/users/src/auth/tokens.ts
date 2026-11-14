import { errors as joseErrors, jwtVerify, SignJWT } from 'jose';
import type { SigningKeys } from './keys.js';
import { roleValues } from '../db/schema.js';
import type { RoleName } from '../db/schema.js';

export const JWT_ALGORITHM = 'RS256';

/** Claims del JWT emitido por users. `role` va como nombre: CONTESTANT | SETTER | ADMIN. */
export interface TokenClaims {
  sub: string;
  username: string;
  role: RoleName;
}

export interface IssuedToken {
  token: string;
  expiresAt: Date;
}

export interface TokenServiceOptions {
  keys: SigningKeys;
  keyId: string;
  issuer: string;
  audience: string;
  ttlSeconds: number;
  now?: () => Date;
}

export class InvalidTokenError extends Error {
  override name = 'InvalidTokenError';
}

export class TokenService {
  private readonly now: () => Date;

  constructor(private readonly opts: TokenServiceOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  get keyId(): string {
    return this.opts.keyId;
  }
  get issuer(): string {
    return this.opts.issuer;
  }
  get audience(): string {
    return this.opts.audience;
  }
  get publicKeyPem(): string {
    return this.opts.keys.publicKeyPem;
  }

  async sign(claims: TokenClaims): Promise<IssuedToken> {
    const iat = Math.floor(this.now().getTime() / 1000);
    const exp = iat + this.opts.ttlSeconds;
    const token = await new SignJWT({ username: claims.username, role: claims.role })
      .setProtectedHeader({ alg: JWT_ALGORITHM, typ: 'JWT', kid: this.opts.keyId })
      .setSubject(claims.sub)
      .setIssuer(this.opts.issuer)
      .setAudience(this.opts.audience)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(this.opts.keys.privateKey);
    return { token, expiresAt: new Date(exp * 1000) };
  }

  /** Verifica firma RS256, `iss`, `aud` y `exp`, y la forma de los claims propios. */
  async verify(token: string): Promise<TokenClaims> {
    try {
      const { payload } = await jwtVerify(token, this.opts.keys.publicKey, {
        algorithms: [JWT_ALGORITHM],
        issuer: this.opts.issuer,
        audience: this.opts.audience,
        currentDate: this.now(),
      });
      const { sub, username, role } = payload;
      if (
        typeof sub !== 'string' ||
        typeof username !== 'string' ||
        typeof role !== 'string' ||
        !(roleValues as readonly string[]).includes(role)
      ) {
        throw new InvalidTokenError('Claims inválidos');
      }
      return { sub, username, role: role as RoleName };
    } catch (err) {
      if (err instanceof InvalidTokenError) throw err;
      if (err instanceof joseErrors.JWTExpired) throw new InvalidTokenError('Token expirado');
      throw new InvalidTokenError('Token inválido');
    }
  }
}
