import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  grpcBaseUrl,
  loadConfig,
  migrateConfigSchema,
  parseConfig,
} from './config.js';
import { createLogger } from './logger.js';

const env = {
  PROBLEMS_DATABASE_URL: 'postgres://problems_svc:pw@localhost:5432/problems',
  S3_ENDPOINT: 'http://minio:9000',
  S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY_ID: 'minioadmin',
  S3_SECRET_ACCESS_KEY: 'secret',
  USERS_GRPC_ADDR: 'localhost:50051',
  JWT_ISSUER: 'juez-users',
  JWT_AUDIENCE: 'juez',
};

describe('config', () => {
  it('aplica defaults de la ficha', () => {
    const c = loadConfig(env);
    expect(c).toMatchObject({
      PROBLEMS_HTTP_PORT: 8082,
      PROBLEMS_GRPC_PORT: 50052,
      S3_REGION: 'us-east-1',
      S3_FORCE_PATH_STYLE: true,
      S3_BUCKET_TESTCASES: 'testcases',
      S3_PRESIGN_TTL_SECONDS: 900,
      S3_JUDGE_PRESIGN_TTL_SECONDS: 600,
      LOG_LEVEL: 'info',
    });
  });

  it('convierte tipos y trata vacíos como ausentes', () => {
    const c = loadConfig({
      ...env,
      PROBLEMS_HTTP_PORT: '9000',
      S3_FORCE_PATH_STYLE: 'false',
      LOG_LEVEL: '',
    });
    expect(c.PROBLEMS_HTTP_PORT).toBe(9000);
    expect(c.S3_FORCE_PATH_STYLE).toBe(false);
    expect(c.LOG_LEVEL).toBe('info');
  });

  it('falla con un mensaje legible', () => {
    expect(() =>
      loadConfig({ ...env, PROBLEMS_DATABASE_URL: 'mysql://x', PROBLEMS_GRPC_PORT: '0' }),
    ).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/PROBLEMS_DATABASE_URL/);
  });

  it('los scripts validan solo lo que usan', () => {
    expect(
      parseConfig(migrateConfigSchema, { PROBLEMS_DATABASE_URL: env.PROBLEMS_DATABASE_URL }),
    ).toMatchObject({
      PROBLEMS_DATABASE_URL: env.PROBLEMS_DATABASE_URL,
    });
  });

  it('grpcBaseUrl', () => {
    expect(grpcBaseUrl('users:50051')).toBe('http://users:50051');
    expect(grpcBaseUrl('https://users')).toBe('https://users');
  });

  it('logger JSON con el nombre del servicio', () => {
    const logger = createLogger('silent');
    expect(logger.level).toBe('silent');
    expect(logger.bindings()).toMatchObject({ service: 'problems', name: 'problems' });
  });
});
