import http2 from 'node:http2';
import { Code, ConnectError } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { UserService } from '@juez/contracts/es';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AUDIENCE, createTestKeys, ISSUER, signToken, type TestKeys } from '../test-utils/jwt.js';
import { silentLogger } from '../test-utils/fakes.js';
import {
  bearerToken,
  JwtVerifier,
  parseRole,
  usersPublicKeySource,
  type PublicKeySource,
} from './jwt.js';

async function expectCode(promise: Promise<unknown>, code: Code, message?: RegExp): Promise<void> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ConnectError);
  expect((err as ConnectError).code).toBe(code);
  if (message) expect((err as ConnectError).rawMessage).toMatch(message);
}

describe('JwtVerifier', () => {
  let keys: TestKeys;
  beforeAll(async () => {
    keys = await createTestKeys();
  });

  const verifier = (source: PublicKeySource, now?: () => number) =>
    new JwtVerifier(source, {
      issuer: ISSUER,
      audience: AUDIENCE,
      logger: silentLogger,
      refreshCooldownMs: 1000,
      now,
    });

  it('verifica el token y extrae el principal', async () => {
    const source = vi.fn(() => Promise.resolve(keys.info));
    const v = verifier(source);
    const principal = await v.verify(
      await signToken(keys, { role: 'ROLE_ADMIN', username: 'root' }),
    );
    expect(principal).toEqual({
      userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      username: 'root',
      role: 'ADMIN',
    });
    await v.verify(await signToken(keys));
    expect(source).toHaveBeenCalledTimes(1); // llave cacheada
  });

  it('rechaza tokens expirados, de otra audiencia o mal formados', async () => {
    const v = verifier(() => Promise.resolve(keys.info));
    await expectCode(
      v.verify(await signToken(keys, { expiresIn: '-1m' })),
      Code.Unauthenticated,
      /expirado/,
    );
    await expectCode(
      v.verify(await signToken(keys, { audience: 'otra' })),
      Code.Unauthenticated,
      /inválido/,
    );
    await expectCode(v.verify(await signToken(keys, { issuer: 'otro' })), Code.Unauthenticated);
    await expectCode(v.verify('no-es-un-jwt'), Code.Unauthenticated);
    await expectCode(
      v.verify(await signToken(keys, { role: 'JEFE' })),
      Code.Unauthenticated,
      /claims/,
    );
    await expectCode(
      v.verify(await signToken(keys, { sub: 'no-uuid' })),
      Code.Unauthenticated,
      /claims/,
    );
  });

  it('rechaza tokens firmados con otra llave', async () => {
    const other = await createTestKeys();
    const v = verifier(() => Promise.resolve(keys.info));
    await expectCode(v.verify(await signToken(other)), Code.Unauthenticated);
  });

  it('UNAVAILABLE si no hay llave y users no responde', async () => {
    const v = verifier(() => Promise.reject(new Error('users caído')));
    expect(await v.warmUp()).toBe(false);
    expect(v.hasKey).toBe(false);
    await expectCode(v.verify(await signToken(keys)), Code.Unavailable);
  });

  it('rechaza algoritmos distintos de RS256', async () => {
    const v = verifier(() => Promise.resolve({ ...keys.info, algorithm: 'ES256' }));
    expect(await v.warmUp()).toBe(false);
  });

  it('recarga la llave ante un kid nuevo (respetando el cooldown)', async () => {
    const rotated = await createTestKeys('test-2');
    let current = keys.info;
    let clock = 0;
    const source = vi.fn(() => Promise.resolve(current));
    const v = verifier(source, () => clock);
    expect(await v.warmUp()).toBe(true);
    current = rotated.info;
    // Dentro del cooldown: usa la llave vieja y falla.
    await expectCode(v.verify(await signToken(rotated)), Code.Unauthenticated);
    clock = 5_000;
    expect(await v.verify(await signToken(rotated))).toMatchObject({ role: 'SETTER' });
    expect(source).toHaveBeenCalledTimes(2);
  });

  it('si la recarga falla, sigue con la llave cacheada', async () => {
    let fail = false;
    let clock = 0;
    const v = verifier(
      () => (fail ? Promise.reject(new Error('caído')) : Promise.resolve(keys.info)),
      () => clock,
    );
    await v.warmUp();
    fail = true;
    clock = 5_000;
    expect(await v.verify(await signToken(keys, { keyId: 'otro' }))).toMatchObject({
      role: 'SETTER',
    });
  });
});

describe('parseRole', () => {
  it('acepta nombre corto, nombre del enum y número', () => {
    expect(parseRole('setter')).toBe('SETTER');
    expect(parseRole('ROLE_CONTESTANT')).toBe('CONTESTANT');
    expect(parseRole(3)).toBe('ADMIN');
    expect(parseRole(0)).toBeUndefined();
    expect(parseRole('X')).toBeUndefined();
    expect(parseRole(null)).toBeUndefined();
  });
});

describe('bearerToken', () => {
  it('extrae el token', () => {
    expect(bearerToken(null)).toBeUndefined();
    expect(bearerToken('  ')).toBeUndefined();
    expect(bearerToken('Bearer abc.def')).toBe('abc.def');
    expect(bearerToken('bearer  abc ')).toBe('abc');
    expect(() => bearerToken('Basic xyz')).toThrow(ConnectError);
  });
});

describe('usersPublicKeySource', () => {
  let server: http2.Http2Server;
  let port: number;

  beforeAll(async () => {
    server = http2.createServer(
      connectNodeAdapter({
        routes: (r) =>
          r.service(UserService, {
            getPublicKey: () => ({
              publicKeyPem: 'PEM',
              keyId: 'dev-1',
              algorithm: 'RS256',
              issuer: ISSUER,
              audience: AUDIENCE,
            }),
          }),
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('pide la llave a users por gRPC', async () => {
    const info = await usersPublicKeySource(`http://localhost:${port}`)();
    expect(info).toEqual({ publicKeyPem: 'PEM', keyId: 'dev-1', algorithm: 'RS256' });
  });
});
