import { status as GrpcStatus } from '@grpc/grpc-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ALICE,
  AUDIENCE,
  createKeys,
  ISSUER,
  KEY_ID,
  signToken,
  silentLogger,
  upstreamError,
} from '../test-utils/fixtures.js';
import type { Keys } from '../test-utils/fixtures.js';
import {
  InvalidTokenError,
  JwtVerifier,
  parseBearer,
  PublicKeyUnavailableError,
} from './jwt-verifier.js';

const keyResponse = (keys: Keys, keyId = KEY_ID) => ({
  publicKeyPem: keys.publicKeyPem,
  keyId,
  algorithm: 'RS256',
  issuer: ISSUER,
  audience: AUDIENCE,
});

afterEach(() => vi.useRealTimers());

describe('JwtVerifier', () => {
  it('verifica tokens válidos y rechaza los inválidos', async () => {
    const keys = await createKeys();
    const users = { getPublicKey: vi.fn(async () => keyResponse(keys)) };
    const v = new JwtVerifier(users, ISSUER, AUDIENCE, silentLogger);
    await v.init();
    expect(v.hasPublicKey()).toBe(true);
    await expect(v.verify(await signToken(keys))).resolves.toEqual({
      sub: ALICE.sub,
      username: 'alice',
      role: 'CONTESTANT',
    });
    await expect(v.verify('nada')).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(
      v.verify(await signToken(keys, ALICE, { expiresIn: Math.floor(Date.now() / 1000) - 5 })),
    ).rejects.toThrow('Token expirado');
    await expect(v.verify(await signToken(keys, ALICE, { issuer: 'otro' }))).rejects.toThrow(
      'Token inválido',
    );
    const other = await createKeys();
    await expect(v.verify(await signToken(other))).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(
      v.verify(await signToken(keys, { ...ALICE, role: 'ROOT' as never })),
    ).rejects.toThrow('Claims inválidos');
    expect(users.getPublicKey).toHaveBeenCalledTimes(1);
  });

  it('users caído al arrancar: reintenta con backoff y mientras tanto informa UNAVAILABLE', async () => {
    vi.useFakeTimers();
    const keys = await createKeys();
    const users = {
      getPublicKey: vi
        .fn()
        .mockRejectedValueOnce(upstreamError('users', GrpcStatus.UNAVAILABLE))
        .mockRejectedValueOnce(upstreamError('users', GrpcStatus.UNAVAILABLE))
        .mockRejectedValueOnce(upstreamError('users', GrpcStatus.UNAVAILABLE))
        .mockResolvedValue(keyResponse(keys)),
    };
    const v = new JwtVerifier(users, ISSUER, AUDIENCE, silentLogger, {
      initialRetryMs: 100,
      maxRetryMs: 1000,
    });
    await v.init();
    expect(v.hasPublicKey()).toBe(false);
    // Una verificación mientras users no responde: no es culpa del token.
    await expect(v.verify(await signToken(keys))).rejects.toBeInstanceOf(PublicKeyUnavailableError);
    await vi.advanceTimersByTimeAsync(100); // reintento 1 (falla)
    expect(v.hasPublicKey()).toBe(false);
    await vi.advanceTimersByTimeAsync(200); // reintento 2 (ok)
    expect(v.hasPublicKey()).toBe(true);
    expect(users.getPublicKey).toHaveBeenCalledTimes(4);
    v.stop();
  });

  it('kid desconocido: refresca la llave (una vez por intervalo) y conserva la anterior si falla', async () => {
    const oldKeys = await createKeys();
    const newKeys = await createKeys();
    const users = {
      getPublicKey: vi
        .fn()
        .mockResolvedValueOnce(keyResponse(oldKeys, 'k-old'))
        .mockResolvedValueOnce(keyResponse(newKeys, 'k-new'))
        .mockRejectedValue(upstreamError('users', GrpcStatus.UNAVAILABLE)),
    };
    const v = new JwtVerifier(users, ISSUER, AUDIENCE, silentLogger, { minRefreshIntervalMs: 0 });
    await v.init();
    await expect(
      v.verify(await signToken(oldKeys, ALICE, { kid: 'k-old' })),
    ).resolves.toBeDefined();
    // Rotación: llega un token con el kid nuevo.
    await expect(
      v.verify(await signToken(newKeys, ALICE, { kid: 'k-new' })),
    ).resolves.toBeDefined();
    expect(users.getPublicKey).toHaveBeenCalledTimes(2);
    // Otro kid desconocido con users caído: se intenta y se mantiene la llave vigente.
    await expect(v.verify(await signToken(newKeys, ALICE, { kid: 'k-x' }))).resolves.toBeDefined();
    expect(v.hasPublicKey()).toBe(true);
  });

  it('no refresca en cada token con kid desconocido', async () => {
    const keys = await createKeys();
    const users = { getPublicKey: vi.fn(async () => keyResponse(keys)) };
    const v = new JwtVerifier(users, ISSUER, AUDIENCE, silentLogger, {
      minRefreshIntervalMs: 60_000,
    });
    await v.init();
    const token = await signToken(keys, ALICE, { kid: 'raro' });
    await v.verify(token);
    await v.verify(token);
    expect(users.getPublicKey).toHaveBeenCalledTimes(1);
  });
});

describe('parseBearer', () => {
  it('extrae el token o falla con un formato inválido', () => {
    expect(parseBearer('Bearer abc')).toBe('abc');
    expect(parseBearer('bearer   abc ')).toBe('abc');
    expect(parseBearer(['Bearer x'])).toBe('x');
    expect(parseBearer(undefined)).toBeUndefined();
    expect(parseBearer('')).toBeUndefined();
    expect(() => parseBearer('Basic abc')).toThrow(InvalidTokenError);
    expect(() => parseBearer(42)).toThrow(InvalidTokenError);
  });
});
