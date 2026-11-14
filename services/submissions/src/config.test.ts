import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

describe('loadConfig', () => {
  const validEnv: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    LOG_LEVEL: 'debug',
    SUBMISSIONS_HTTP_PORT: '8083',
    SUBMISSIONS_GRPC_PORT: '50053',
    SUBMISSIONS_DATABASE_URL: 'postgres://submissions_svc:pass@localhost:5432/submissions',
    KAFKA_BROKERS: 'localhost:9092,localhost:9093',
    SUBMISSIONS_KAFKA_CLIENT_ID: 'submissions-test',
    SUBMISSIONS_KAFKA_GROUP_ID: 'submissions-test-group',
    SUBMISSIONS_OUTBOX_POLL_INTERVAL_MS: '200',
    SUBMISSIONS_OUTBOX_BATCH_SIZE: '50',
    USERS_GRPC_ADDR: 'localhost:50051',
    PROBLEMS_GRPC_ADDR: 'localhost:50052',
    RANKING_GRPC_ADDR: 'localhost:50054',
    JWT_ISSUER: 'juez-users',
    JWT_AUDIENCE: 'juez',
  };

  it('carga la configuración correctamente con valores válidos', () => {
    const config = loadConfig(validEnv);
    expect(config.nodeEnv).toBe('test');
    expect(config.logLevel).toBe('debug');
    expect(config.httpPort).toBe(8083);
    expect(config.grpcPort).toBe(50053);
    expect(config.databaseUrl).toBe(validEnv.SUBMISSIONS_DATABASE_URL);
    expect(config.kafka.brokers).toEqual(['localhost:9092', 'localhost:9093']);
    expect(config.kafka.clientId).toBe('submissions-test');
    expect(config.kafka.groupId).toBe('submissions-test-group');
    expect(config.outbox.pollIntervalMs).toBe(200);
    expect(config.outbox.batchSize).toBe(50);
    expect(config.grpcAddrs.users).toBe('localhost:50051');
    expect(config.grpcAddrs.problems).toBe('localhost:50052');
    expect(config.grpcAddrs.ranking).toBe('localhost:50054');
    expect(config.jwt.issuer).toBe('juez-users');
    expect(config.jwt.audience).toBe('juez');
  });

  it('aplica valores por defecto cuando no se especifican campos opcionales', () => {
    const minimalEnv: NodeJS.ProcessEnv = {
      SUBMISSIONS_DATABASE_URL: 'postgres://submissions_svc:pass@localhost:5432/submissions',
      KAFKA_BROKERS: 'localhost:9092',
    };
    const config = loadConfig(minimalEnv);
    expect(config.nodeEnv).toBe('development');
    expect(config.logLevel).toBe('info');
    expect(config.httpPort).toBe(8083);
    expect(config.grpcPort).toBe(50053);
    expect(config.kafka.clientId).toBe('submissions');
    expect(config.kafka.groupId).toBe('submissions');
    expect(config.outbox.pollIntervalMs).toBe(500);
    expect(config.outbox.batchSize).toBe(100);
  });

  it('lanza ConfigError si falta una variable requerida', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });

  it('lanza ConfigError si la URL de base de datos no es de postgres', () => {
    expect(() =>
      loadConfig({
        SUBMISSIONS_DATABASE_URL: 'mysql://root@localhost:3306/db',
        KAFKA_BROKERS: 'localhost:9092',
      }),
    ).toThrow(ConfigError);
  });
});
