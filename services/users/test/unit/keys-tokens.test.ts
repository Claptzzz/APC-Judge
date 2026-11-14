import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeProtectedHeader, decodeJwt, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { KeyError, keysFromPem, loadSigningKeys } from '../../src/auth/keys.js';
import { InvalidTokenError } from '../../src/auth/tokens.js';
import { rsaPem, testKeys, testTokens } from '../helpers.js';

describe('keys', () => {
  it('deriva la pública de la privada y la expone en PEM SPKI', () => {
    const keys = keysFromPem(rsaPem().privatePem);
    expect(keys.publicKeyPem).toBe(rsaPem().publicPem);
  });

  it('rechaza una pública que no corresponde', () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString();
    expect(() => keysFromPem(rsaPem().privatePem, other)).toThrow(KeyError);
  });

  it('rechaza llaves que no son RSA o que son cortas', () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    expect(() => keysFromPem(ec)).toThrow(/RSA/);
    const short = generateKeyPairSync('rsa', { modulusLength: 1024 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    expect(() => keysFromPem(short)).toThrow(/2048/);
  });

  it('carga desde archivos e indica cómo generarlas si faltan', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'users-keys-'));
    writeFileSync(join(dir, 'priv.pem'), rsaPem().privatePem);
    writeFileSync(join(dir, 'pub.pem'), rsaPem().publicPem);
    const keys = await loadSigningKeys(join(dir, 'priv.pem'), join(dir, 'pub.pem'));
    expect(keys.publicKeyPem).toBe(rsaPem().publicPem);
    await expect(loadSigningKeys(join(dir, 'no.pem'))).rejects.toThrow(/jwt:keys/);
  });
});

describe('TokenService', () => {
  const now = new Date('2026-11-11T12:00:00Z');
  const tokens = testTokens({ now: () => now });

  it('firma RS256 con kid, iss, aud, sub, username, role y exp = iat + 1 h', async () => {
    const { token, expiresAt } = await tokens.sign({ sub: 'u-1', username: 'ada', role: 'SETTER' });
    expect(decodeProtectedHeader(token)).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'test-1' });
    const claims = decodeJwt(token);
    expect(claims).toMatchObject({
      sub: 'u-1',
      username: 'ada',
      role: 'SETTER',
      iss: 'juez-users',
      aud: 'juez',
    });
    expect(claims.exp! - claims.iat!).toBe(3600);
    expect(expiresAt.toISOString()).toBe('2026-11-11T13:00:00.000Z');
    await expect(tokens.verify(token)).resolves.toEqual({
      sub: 'u-1',
      username: 'ada',
      role: 'SETTER',
    });
  });

  it('rechaza tokens expirados', async () => {
    const { token } = await tokens.sign({ sub: 'u-1', username: 'ada', role: 'ADMIN' });
    const later = testTokens({ now: () => new Date(now.getTime() + 3601_000) });
    await expect(later.verify(token)).rejects.toThrow('Token expirado');
  });

  it('rechaza otra audiencia, otra llave o basura', async () => {
    const { token } = await tokens.sign({ sub: 'u-1', username: 'ada', role: 'ADMIN' });
    await expect(testTokens({ audience: 'otra', now: () => now }).verify(token)).rejects.toThrow(
      InvalidTokenError,
    );
    const otherKey = keysFromPem(
      generateKeyPairSync('rsa', { modulusLength: 2048 })
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString(),
    );
    await expect(testTokens({ keys: otherKey, now: () => now }).verify(token)).rejects.toThrow(
      'Token inválido',
    );
    await expect(tokens.verify('no.es.jwt')).rejects.toThrow('Token inválido');
  });

  it('rechaza tokens bien firmados con claims propios inválidos', async () => {
    const forged = await new SignJWT({ username: 'ada', role: 'ROOT' })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('u-1')
      .setIssuer('juez-users')
      .setAudience('juez')
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(Math.floor(now.getTime() / 1000) + 60)
      .sign(testKeys().privateKey);
    await expect(tokens.verify(forged)).rejects.toThrow('Claims inválidos');
  });

  it('expone los datos públicos para GetPublicKey', () => {
    expect(tokens.keyId).toBe('test-1');
    expect(tokens.issuer).toBe('juez-users');
    expect(tokens.audience).toBe('juez');
    expect(tokens.publicKeyPem).toBe(rsaPem().publicPem);
  });
});
