import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, resolveFilePath } from '../../src/config.js';

const base = {
  USERS_DATABASE_URL: 'postgres://users_svc:pw@localhost:5432/users',
  KAFKA_BROKERS: 'localhost:9092, otro:9093',
  JWT_PRIVATE_KEY_PATH: '/keys/private.pem',
};

describe('loadConfig', () => {
  it('aplica valores por defecto de la ficha', () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({
      httpPort: 8081,
      grpcPort: 50051,
      logLevel: 'info',
      kafka: { brokers: ['localhost:9092', 'otro:9093'], clientId: 'users' },
      outbox: { pollIntervalMs: 500, batchSize: 100 },
      jwt: {
        privateKeyPath: '/keys/private.pem',
        publicKeyPath: undefined,
        keyId: 'dev-1',
        issuer: 'juez-users',
        audience: 'juez',
        ttlSeconds: 3600,
      },
      admin: undefined,
    });
  });

  it('lee puertos y admin desde el entorno', () => {
    const c = loadConfig({
      ...base,
      USERS_HTTP_PORT: '9081',
      USERS_GRPC_PORT: '0',
      JWT_PUBLIC_KEY_PATH: '/keys/public.pem',
      USERS_ADMIN_USERNAME: 'admin',
      USERS_ADMIN_EMAIL: 'admin@juez.local',
      USERS_ADMIN_PASSWORD: 'una-clave-larga',
    });
    expect(c.httpPort).toBe(9081);
    expect(c.grpcPort).toBe(0);
    expect(c.jwt.publicKeyPath).toBe('/keys/public.pem');
    expect(c.admin).toEqual({
      username: 'admin',
      email: 'admin@juez.local',
      password: 'una-clave-larga',
    });
  });

  it('lista todos los problemas en un ConfigError', () => {
    let error: unknown;
    try {
      loadConfig({ USERS_DATABASE_URL: 'mysql://x', USERS_HTTP_PORT: 'abc' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const issues = (error as ConfigError).issues.join('\n');
    for (const name of [
      'USERS_DATABASE_URL',
      'USERS_HTTP_PORT',
      'KAFKA_BROKERS',
      'JWT_PRIVATE_KEY_PATH',
    ]) {
      expect(issues).toContain(name);
    }
  });

  it('exige las tres variables USERS_ADMIN_* juntas', () => {
    expect(() => loadConfig({ ...base, USERS_ADMIN_USERNAME: 'admin' })).toThrow(/van juntas/);
  });
});

describe('resolveFilePath', () => {
  const root = mkdtempSync(join(tmpdir(), 'users-cfg-'));
  writeFileSync(join(root, 'pnpm-workspace.yaml'), '');
  mkdirSync(join(root, '.secrets'));
  writeFileSync(join(root, '.secrets', 'k.pem'), 'x');
  const service = join(root, 'services', 'users');
  mkdirSync(service, { recursive: true });
  writeFileSync(join(service, 'local.pem'), 'x');

  it('respeta rutas absolutas', () => {
    expect(resolveFilePath('/abs/k.pem', service)).toBe('/abs/k.pem');
  });

  it('prefiere el archivo relativo al cwd si existe', () => {
    expect(resolveFilePath('local.pem', service)).toBe(join(service, 'local.pem'));
  });

  it('si no, resuelve desde la raíz del workspace', () => {
    expect(resolveFilePath('.secrets/k.pem', service)).toBe(join(root, '.secrets', 'k.pem'));
  });

  it('sin workspace, devuelve la ruta relativa al cwd', () => {
    const lonely = mkdtempSync(join(tmpdir(), 'users-nows-'));
    expect(resolveFilePath('nada.pem', lonely)).toBe(join(lonely, 'nada.pem'));
  });
});
