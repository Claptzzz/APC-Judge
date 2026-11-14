import { exportSPKI, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import type { PublicKeyInfo } from '../auth/jwt.js';

export const ISSUER = 'juez-users';
export const AUDIENCE = 'juez';

export interface TestKeys {
  privateKey: CryptoKey;
  info: PublicKeyInfo;
}

export async function createTestKeys(keyId = 'test-1'): Promise<TestKeys> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  return {
    privateKey,
    info: { publicKeyPem: await exportSPKI(publicKey), keyId, algorithm: 'RS256' },
  };
}

export interface TokenOptions {
  sub?: string;
  role?: unknown;
  username?: string;
  issuer?: string;
  audience?: string;
  expiresIn?: string | number;
  keyId?: string;
}

export function signToken(keys: TestKeys, opts: TokenOptions = {}): Promise<string> {
  const claims: Record<string, unknown> = {
    username: opts.username ?? 'ana',
    role: opts.role ?? 'SETTER',
  };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: opts.keyId ?? keys.info.keyId })
    .setSubject(opts.sub ?? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? '1h')
    .sign(keys.privateKey);
}
