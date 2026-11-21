import { createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Code, ConnectError } from '@connectrpc/connect';
import {
  extractBearerToken,
  InvalidTokenError,
  JwtVerifier,
  PublicKeyUnavailableError,
} from './jwt-verifier.js';
import type { JwtVerifierOptions } from './jwt-verifier.js';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { classifyUpstreamError } from '../clients/errors.js';
import { createLogger } from '../logger.js';

const logger = createLogger('silent');

async function signedToken(privateKey: CryptoKey) {
  return new SignJWT({ username: 'testuser', role: 'CONTESTANT' })
    .setProtectedHeader({ alg: 'RS256', kid: 'dev-1' })
    .setSubject('550e8400-e29b-41d4-a716-446655440000')
    .setIssuer('juez-users')
    .setAudience('juez')
    .setExpirationTime('1h')
    .sign(privateKey);
}

/** Verifier con el cliente de users reemplazado por un fake. */
function withFakeUsers(getPublicKey: ReturnType<typeof vi.fn>, opts?: JwtVerifierOptions) {
  const verifier = new JwtVerifier('localhost:50051', 'juez-users', 'juez', logger, opts);
  // @ts-expect-error test hook
  verifier.client = { getPublicKey };
  return verifier;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );
}

describe('jwt-verifier', () => {
  describe('extractBearerToken', () => {
    it('extrae el token cuando viene en formato string Bearer', () => {
      const metadata = {
        get: (key: string) => (key === 'authorization' ? 'Bearer my-token-123' : undefined),
      };
      expect(extractBearerToken(metadata)).toBe('my-token-123');
    });

    it('extrae el token cuando viene como array', () => {
      const metadata = {
        get: (key: string) => (key === 'authorization' ? ['Bearer my-token-123'] : undefined),
      };
      expect(extractBearerToken(metadata)).toBe('my-token-123');
    });

    it('lanza InvalidTokenError si falta metadata o header', () => {
      expect(() => extractBearerToken(undefined)).toThrow(InvalidTokenError);
      expect(() => extractBearerToken({ get: () => undefined })).toThrow(InvalidTokenError);
    });

    it('lanza InvalidTokenError si no tiene prefijo Bearer', () => {
      const metadata = {
        get: () => 'Basic user:pass',
      };
      expect(() => extractBearerToken(metadata)).toThrow(InvalidTokenError);
    });
  });

  describe('JwtVerifier.verify', () => {
    it('verifica un token firmado válidamente', async () => {
      const keyPair = await generateKeyPair('RS256');
      const verifier = new JwtVerifier(
        'localhost:50051',
        'juez-users',
        'juez',
        createLogger('silent'),
      );
      // Asignar llave pública directamente para el test
      // @ts-expect-error test hook
      verifier.publicKey = keyPair.publicKey;

      const token = await new SignJWT({ username: 'testuser', role: 'CONTESTANT' })
        .setProtectedHeader({ alg: 'RS256', kid: 'dev-1' })
        .setSubject('550e8400-e29b-41d4-a716-446655440000')
        .setIssuer('juez-users')
        .setAudience('juez')
        .setExpirationTime('1h')
        .sign(keyPair.privateKey);

      const claims = await verifier.verify(token);
      expect(claims.sub).toBe('550e8400-e29b-41d4-a716-446655440000');
      expect(claims.username).toBe('testuser');
      expect(claims.role).toBe('CONTESTANT');
    });

    it('falla con token expirado', async () => {
      const keyPair = await generateKeyPair('RS256');
      const verifier = new JwtVerifier(
        'localhost:50051',
        'juez-users',
        'juez',
        createLogger('silent'),
      );
      // @ts-expect-error test hook
      verifier.publicKey = keyPair.publicKey;

      const expiredToken = await new SignJWT({ username: 'testuser', role: 'CONTESTANT' })
        .setProtectedHeader({ alg: 'RS256', kid: 'dev-1' })
        .setSubject('550e8400-e29b-41d4-a716-446655440000')
        .setIssuer('juez-users')
        .setAudience('juez')
        .setExpirationTime('-10s')
        .sign(keyPair.privateKey);

      await expect(verifier.verify(expiredToken)).rejects.toThrow(InvalidTokenError);
    });

    it('falla con claims no conformes', async () => {
      const keyPair = await generateKeyPair('RS256');
      const verifier = new JwtVerifier(
        'localhost:50051',
        'juez-users',
        'juez',
        createLogger('silent'),
      );
      // @ts-expect-error test hook
      verifier.publicKey = keyPair.publicKey;

      const invalidToken = await new SignJWT({ username: 'testuser', role: 'SUPERUSER' })
        .setProtectedHeader({ alg: 'RS256' })
        .setSubject('550e8400-e29b-41d4-a716-446655440000')
        .setIssuer('juez-users')
        .setAudience('juez')
        .setExpirationTime('1h')
        .sign(keyPair.privateKey);

      await expect(verifier.verify(invalidToken)).rejects.toThrow(InvalidTokenError);
    });
  });

  describe('JwtVerifier — llave pública de users', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('pide GetPublicKey con timeout de 3 s y cachea la llave', async () => {
      const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
      const getPublicKey = vi.fn().mockResolvedValue({
        publicKeyPem: await exportSPKI(publicKey),
        algorithm: 'RS256',
        keyId: 'dev-1',
      });
      const verifier = withFakeUsers(getPublicKey);

      await verifier.init();
      expect(verifier.hasPublicKey()).toBe(true);
      expect(getPublicKey).toHaveBeenCalledWith({}, { timeoutMs: 3000 });

      const claims = await verifier.verify(await signedToken(privateKey));
      expect(claims.role).toBe('CONTESTANT');
      expect(getPublicKey).toHaveBeenCalledTimes(1);
    });

    it('si users no responde, verify lanza PublicKeyUnavailableError (no InvalidTokenError)', async () => {
      const verifier = withFakeUsers(
        vi.fn().mockRejectedValue(new ConnectError('down', Code.Unavailable)),
      );
      const err = await verifier.verify('cualquier-token').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PublicKeyUnavailableError);
      expect(err).not.toBeInstanceOf(InvalidTokenError);
      expect(classifyUpstreamError((err as Error).cause)).toBe('unavailable');
    });

    it('las verificaciones concurrentes comparten una sola petición a users', async () => {
      const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
      const pem = await exportSPKI(publicKey);
      const getPublicKey = vi.fn().mockResolvedValue({ publicKeyPem: pem, algorithm: 'RS256' });
      const verifier = withFakeUsers(getPublicKey);
      const token = await signedToken(privateKey);

      await Promise.all([verifier.verify(token), verifier.verify(token), verifier.verify(token)]);
      expect(getPublicKey).toHaveBeenCalledTimes(1);
    });

    it('init() no lanza y reintenta en segundo plano con backoff hasta obtener la llave', async () => {
      vi.useFakeTimers();
      const { publicKey } = await generateKeyPair('RS256', { extractable: true });
      const pem = await exportSPKI(publicKey);
      const getPublicKey = vi
        .fn()
        .mockRejectedValueOnce(new ConnectError('down', Code.Unavailable))
        .mockRejectedValueOnce(new ConnectError('timeout', Code.DeadlineExceeded))
        .mockResolvedValue({ publicKeyPem: pem, algorithm: 'RS256' });
      const verifier = withFakeUsers(getPublicKey, { initialRetryMs: 100, maxRetryMs: 1000 });

      await expect(verifier.init()).resolves.toBeUndefined();
      expect(verifier.hasPublicKey()).toBe(false);

      await vi.advanceTimersByTimeAsync(100);
      expect(getPublicKey).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(199);
      expect(getPublicKey).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(getPublicKey).toHaveBeenCalledTimes(3);
      expect(verifier.hasPublicKey()).toBe(true);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(getPublicKey).toHaveBeenCalledTimes(3);
    });

    it('stop() cancela los reintentos', async () => {
      vi.useFakeTimers();
      const getPublicKey = vi.fn().mockRejectedValue(new ConnectError('down', Code.Unavailable));
      const verifier = withFakeUsers(getPublicKey, { initialRetryMs: 100 });

      await verifier.init();
      verifier.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getPublicKey).toHaveBeenCalledTimes(1);
    });
  });

  describe('JwtVerifier — users real caído (sin mocks)', () => {
    let closedPort: number;
    let silentServer: Server;
    let silentPort: number;
    const sockets = new Set<Socket>();

    beforeAll(async () => {
      const tmp = createServer();
      closedPort = await listen(tmp);
      await new Promise((r) => tmp.close(r));
      silentServer = createServer((sock) => {
        sockets.add(sock);
        sock.on('close', () => sockets.delete(sock));
      });
      silentPort = await listen(silentServer);
    });

    afterAll(async () => {
      for (const sock of sockets) sock.destroy();
      await new Promise((r) => silentServer.close(r));
    });

    it('conexión rechazada → PublicKeyUnavailableError clasificado como unavailable', async () => {
      const verifier = new JwtVerifier(`127.0.0.1:${closedPort}`, 'juez-users', 'juez', logger);
      const err = await verifier.verify('token').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PublicKeyUnavailableError);
      expect(classifyUpstreamError((err as Error).cause)).toBe('unavailable');
    });

    it('users que no responde → vence el timeout → unavailable', async () => {
      const verifier = new JwtVerifier(`127.0.0.1:${silentPort}`, 'juez-users', 'juez', logger, {
        timeoutMs: 200,
      });
      const started = Date.now();
      const err = await verifier.verify('token').catch((e: unknown) => e);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(err).toBeInstanceOf(PublicKeyUnavailableError);
      expect(classifyUpstreamError((err as Error).cause)).toBe('unavailable');
    });
  });
});
