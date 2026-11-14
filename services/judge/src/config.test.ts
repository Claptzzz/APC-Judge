import { describe, expect, it } from 'vitest';
import { loadConfig, toBaseUrl } from './config.js';

const base = { KAFKA_BROKERS: 'localhost:9092', PROBLEMS_GRPC_ADDR: 'localhost:50052' };

describe('loadConfig', () => {
  it('aplica los valores por defecto de la ficha', () => {
    const config = loadConfig(base);
    expect(config).toEqual({
      httpPort: 8085,
      kafka: { brokers: ['localhost:9092'], clientId: 'judge', groupId: 'judge' },
      problemsBaseUrl: 'http://localhost:50052',
      concurrency: 1,
      workdir: '/tmp/juez-judge',
      compileTimeoutMs: 10_000,
      maxOutputBytes: 65_536 * 1024,
      logLevel: 'info',
    });
  });

  it('lee todas las variables', () => {
    const config = loadConfig({
      ...base,
      KAFKA_BROKERS: 'k1:9092, k2:9092,',
      JUDGE_HTTP_PORT: '9000',
      JUDGE_KAFKA_CLIENT_ID: 'c',
      JUDGE_KAFKA_GROUP_ID: 'g',
      JUDGE_CONCURRENCY: '2',
      JUDGE_WORKDIR: '/w',
      JUDGE_COMPILE_TIMEOUT_MS: '5000',
      JUDGE_MAX_OUTPUT_KB: '10',
      LOG_LEVEL: 'debug',
    });
    expect(config.kafka).toEqual({ brokers: ['k1:9092', 'k2:9092'], clientId: 'c', groupId: 'g' });
    expect(config.httpPort).toBe(9000);
    expect(config.concurrency).toBe(2);
    expect(config.maxOutputBytes).toBe(10_240);
    expect(config.logLevel).toBe('debug');
  });

  it('falla con un mensaje que nombra cada variable inválida', () => {
    expect(() => loadConfig({ JUDGE_HTTP_PORT: 'abc' })).toThrow(
      /KAFKA_BROKERS.*|PROBLEMS_GRPC_ADDR/,
    );
    expect(() => loadConfig({ ...base, JUDGE_HTTP_PORT: '70000' })).toThrow(/JUDGE_HTTP_PORT/);
    expect(() => loadConfig({ ...base, KAFKA_BROKERS: ' , ' })).toThrow(/KAFKA_BROKERS/);
    expect(() => loadConfig({ ...base, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
  });
});

describe('toBaseUrl', () => {
  it('agrega http:// solo si falta el esquema', () => {
    expect(toBaseUrl('problems:50052')).toBe('http://problems:50052');
    expect(toBaseUrl('https://problems:50052')).toBe('https://problems:50052');
  });
});
