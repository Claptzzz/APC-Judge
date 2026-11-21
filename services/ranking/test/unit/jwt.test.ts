import { Code, ConnectError } from '@connectrpc/connect';
import { describe, expect, it, vi } from 'vitest';
import { bearerToken, JwtVerifier, parseRole, usersPublicKeySource } from '../../src/auth/jwt.js';
import { rsaKeys, signToken, uuid } from '../helpers.js';

async function code(p: Promise<unknown>) {
  return p.then(
    () => undefined,
    (e: unknown) => ConnectError.from(e).code,
  );
}

async function verifierWith(
  source = vi.fn(),
  opts: Partial<ConstructorParameters<typeof JwtVerifier>[1]> = {},
) {
  return new JwtVerifier(source, { issuer: 'juez-users', audience: 'juez', ...opts });
}

describe('JwtVerifier', () => {
  it('verifica tokens válidos y normaliza el rol', async () => {
    const { privateKey, publicKeyPem } = await rsaKeys();
    const v = await verifierWith(
      vi.fn(async () => ({ publicKeyPem, keyId: 'test-1', algorithm: 'RS256' })),
    );
    const token = await signToken(privateKey, {
      sub: uuid(3),
      role: 'ROLE_SETTER',
      username: 'ana',
    });
    expect(await v.verify(token)).toEqual({ userId: uuid(3), username: 'ana', role: 'SETTER' });
    expect(v.hasKey).toBe(true);
  });

  it('rechaza tokens expirados, con otro issuer, mal formados o con claims inválidos', async () => {
    const { privateKey, publicKeyPem } = await rsaKeys();
    const v = await verifierWith(
      vi.fn(async () => ({ publicKeyPem, keyId: 'test-1', algorithm: 'RS256' })),
    );
    const expired = await signToken(privateKey, {}, { expiresIn: '-1m' });
    const otherIssuer = await signToken(privateKey, {}, { issuer: 'otro' });
    const badRole = await signToken(privateKey, { role: 'ROOT' });
    const badSub = await signToken(privateKey, { sub: 'no-uuid' });
    for (const t of [expired, otherIssuer, badRole, badSub, 'x.y.z', 'garbage']) {
      expect(await code(v.verify(t))).toBe(Code.Unauthenticated);
    }
  });

  it('UNAVAILABLE (no UNAUTHENTICATED) si la llave de users no está disponible', async () => {
    const { privateKey } = await rsaKeys();
    const v = await verifierWith(vi.fn(async () => Promise.reject(new Error('users caído'))));
    expect(await code(v.verify(await signToken(privateKey)))).toBe(Code.Unavailable);
  });

  it('start() no rechaza y reintenta en segundo plano hasta obtener la llave', async () => {
    const { publicKeyPem } = await rsaKeys();
    const source = vi
      .fn()
      .mockRejectedValueOnce(new Error('caído'))
      .mockRejectedValueOnce(new Error('caído'))
      .mockResolvedValue({ publicKeyPem, keyId: 'k', algorithm: 'RS256' });
    const v = await verifierWith(source, { initialRetryMs: 5, maxRetryMs: 10 });
    await v.start();
    expect(v.hasKey).toBe(false);
    await vi.waitFor(() => expect(v.hasKey).toBe(true), { timeout: 2_000 });
    expect(source).toHaveBeenCalledTimes(3);
    v.stop();
  });

  it('recarga la llave ante un kid desconocido (respetando el cooldown)', async () => {
    const { privateKey, publicKeyPem } = await rsaKeys();
    let now = 1_000_000;
    const source = vi.fn(async () => ({ publicKeyPem, keyId: 'old', algorithm: 'RS256' }));
    const v = await verifierWith(source, { refreshCooldownMs: 1_000, now: () => now });
    const token = await signToken(privateKey, {}, { kid: 'new', expiresIn: '10y' });
    await v.verify(token);
    await v.verify(token);
    expect(source).toHaveBeenCalledTimes(1);
    now += 2_000;
    await v.verify(token);
    expect(source).toHaveBeenCalledTimes(2);
  });

  it('rechaza llaves de un algoritmo no soportado', async () => {
    const v = await verifierWith(
      vi.fn(async () => ({ publicKeyPem: 'x', keyId: 'k', algorithm: 'HS256' })),
    );
    await v.start();
    expect(v.hasKey).toBe(false);
    v.stop();
  });

  it('usersPublicKeySource contra un puerto cerrado falla', async () => {
    await expect(usersPublicKeySource('http://127.0.0.1:1', 500)()).rejects.toBeDefined();
  });
});

describe('helpers de auth', () => {
  it('parseRole', () => {
    expect(parseRole('admin')).toBe('ADMIN');
    expect(parseRole(1)).toBe('CONTESTANT');
    expect(parseRole(9)).toBeUndefined();
    expect(parseRole(null)).toBeUndefined();
  });

  it('bearerToken', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer  abc ')).toBe('abc');
    expect(() => bearerToken(null)).toThrow(/falta/);
    expect(() => bearerToken('Token abc')).toThrow(/mal formado/);
  });
});
