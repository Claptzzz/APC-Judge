import { describe, expect, it } from 'vitest';
import { extractBearerToken, InvalidTokenError, JwtVerifier } from './jwt-verifier.js';
import { generateKeyPair, SignJWT } from 'jose';
import { createLogger } from '../logger.js';

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
});
