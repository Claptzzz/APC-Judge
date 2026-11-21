import { createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import { Code, ConnectError } from '@connectrpc/connect';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  backoffDelay,
  createUsersKeyClient,
  extractBearerToken,
  InvalidTokenError,
  JwtVerifier,
  PublicKeyUnavailableError,
} from './jwt.js';
import type { JwtVerifierOptions } from './jwt.js';
import { classifyUpstreamError } from '../upstream/errors.js';
import {
  ALICE,
  AUDIENCE,
  createKeys,
  ISSUER,
  signToken,
  silentLogger,
} from '../test-utils/fixtures.js';
import type { Keys } from '../test-utils/fixtures.js';

let keys: Keys;
beforeAll(async () => {
  keys = await createKeys();
});

function verifierWith(
  getPublicKey: ReturnType<typeof vi.fn>,
  opts: Partial<JwtVerifierOptions> = {},
) {
  return new JwtVerifier({ getPublicKey } as never, {
    issuer: ISSUER,
    audience: AUDIENCE,
    logger: silentLogger,
    ...opts,
  });
}

const keyResponse = () => ({ publicKeyPem: keys.publicKeyPem, algorithm: 'RS256', keyId: 'dev-1' });

describe('extractBearerToken', () => {
  it('extrae el token (string o array, sin importar mayúsculas de "Bearer")', () => {
    expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(extractBearerToken(['bearer xyz'])).toBe('xyz');
  });

  it.each([undefined, '', 'Basic abc', 'Bearer', 'Bearer a b'])('rechaza %j', (header) => {
    expect(() => extractBearerToken(header)).toThrow(InvalidTokenError);
  });
});

describe('backoffDelay', () => {
  it('duplica y se topa en el máximo', () => {
    expect([0, 1, 2, 4, 5, 10].map((a) => backoffDelay(a, 1000, 30_000))).toEqual([
      1000, 2000, 4000, 16_000, 30_000, 30_000,
    ]);
  });
});

describe('JwtVerifier', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pide GetPublicKey con timeout de 3 s, cachea la llave y verifica tokens', async () => {
    const getPublicKey = vi.fn().mockResolvedValue(keyResponse());
    const verifier = verifierWith(getPublicKey);
    expect(verifier.hasPublicKey()).toBe(false);

    await verifier.init();
    expect(verifier.hasPublicKey()).toBe(true);
    expect(getPublicKey).toHaveBeenCalledWith({}, { timeoutMs: 3000 });

    await expect(verifier.verify(await signToken(keys))).resolves.toEqual(ALICE);
    expect(getPublicKey).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['expirado', { expiresIn: '-1m' }, 'Token expirado'],
    ['issuer equivocado', { issuer: 'otro' }, 'Token inválido'],
    ['audience equivocada', { audience: 'otra' }, 'Token inválido'],
    ['rol desconocido', { role: 'ROOT' }, 'Claims inválidos'],
  ])('token %s → InvalidTokenError', async (_name, overrides, message) => {
    const verifier = verifierWith(vi.fn().mockResolvedValue(keyResponse()));
    await expect(verifier.verify(await signToken(keys, overrides))).rejects.toThrow(
      new InvalidTokenError(message),
    );
  });

  it('token firmado con otra llave o basura → InvalidTokenError', async () => {
    const verifier = verifierWith(vi.fn().mockResolvedValue(keyResponse()));
    await expect(verifier.verify(await signToken(await createKeys()))).rejects.toThrow(
      InvalidTokenError,
    );
    await expect(verifier.verify('no.es.jwt')).rejects.toThrow(InvalidTokenError);
  });

  it('si users no responde: PublicKeyUnavailableError (no InvalidTokenError)', async () => {
    const verifier = verifierWith(
      vi.fn().mockRejectedValue(new ConnectError('down', Code.Unavailable)),
    );
    const err = await verifier.verify(await signToken(keys)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublicKeyUnavailableError);
    expect(classifyUpstreamError((err as Error).cause)).toBe('unavailable');
  });

  it('las verificaciones concurrentes comparten una sola petición a users', async () => {
    const getPublicKey = vi.fn().mockResolvedValue(keyResponse());
    const verifier = verifierWith(getPublicKey);
    const t = await signToken(keys);
    await Promise.all([verifier.verify(t), verifier.verify(t), verifier.verify(t)]);
    expect(getPublicKey).toHaveBeenCalledTimes(1);
  });

  it('init() no lanza y reintenta en segundo plano con backoff hasta obtener la llave', async () => {
    vi.useFakeTimers();
    const getPublicKey = vi
      .fn()
      .mockRejectedValueOnce(new ConnectError('down', Code.Unavailable))
      .mockRejectedValueOnce(new ConnectError('timeout', Code.DeadlineExceeded))
      .mockResolvedValue(keyResponse());
    const verifier = verifierWith(getPublicKey, { initialRetryMs: 100, maxRetryMs: 1000 });

    await expect(verifier.init()).resolves.toBeUndefined();
    expect(verifier.hasPublicKey()).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(getPublicKey).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(getPublicKey).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(getPublicKey).toHaveBeenCalledTimes(3);
    expect(verifier.hasPublicKey()).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getPublicKey).toHaveBeenCalledTimes(3);
  });

  it('stop() cancela los reintentos', async () => {
    vi.useFakeTimers();
    const getPublicKey = vi.fn().mockRejectedValue(new ConnectError('down', Code.Unavailable));
    const verifier = verifierWith(getPublicKey, { initialRetryMs: 100 });
    await verifier.init();
    verifier.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getPublicKey).toHaveBeenCalledTimes(1);
  });
});

describe('JwtVerifier contra users real caído (sin mocks)', () => {
  let closedPort: number;
  let silent: Server;
  let silentPort: number;
  const sockets = new Set<Socket>();
  const listen = (server: Server) =>
    new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
    );

  beforeAll(async () => {
    const tmp = createServer();
    closedPort = await listen(tmp);
    await new Promise((r) => tmp.close(r));
    silent = createServer((s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    silentPort = await listen(silent);
  });

  afterAll(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => silent.close(r));
  });

  it('conexión rechazada → unavailable', async () => {
    const verifier = new JwtVerifier(createUsersKeyClient(`http://127.0.0.1:${closedPort}`), {
      issuer: ISSUER,
      audience: AUDIENCE,
      logger: silentLogger,
    });
    const err = await verifier.verify('t').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublicKeyUnavailableError);
    expect(classifyUpstreamError((err as Error).cause)).toBe('unavailable');
  });

  it('users que no responde → vence el timeout → unavailable', async () => {
    const verifier = new JwtVerifier(createUsersKeyClient(`http://127.0.0.1:${silentPort}`), {
      issuer: ISSUER,
      audience: AUDIENCE,
      logger: silentLogger,
      timeoutMs: 200,
    });
    const started = Date.now();
    const err = await verifier.verify('t').catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(classifyUpstreamError((err as Error).cause)).toBe('unavailable');
  });
});
