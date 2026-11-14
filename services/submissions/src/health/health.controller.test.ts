import { describe, expect, it, vi } from 'vitest';
import { HealthController } from './health.controller.js';
import { createMetrics } from '../metrics.js';
import type { Database } from '../db/client.js';
import type { EventPublisher } from '../outbox/publisher.js';
import type { OutboxRelay } from '../outbox/relay.js';
import { HttpException } from '@nestjs/common';

describe('HealthController', () => {
  const metrics = createMetrics({ defaultMetrics: false });

  const fakeDatabase: Database = {
    db: {} as never,
    ping: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };

  const fakePublisher: EventPublisher = {
    connect: vi.fn(),
    publish: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    disconnect: vi.fn(),
  };

  const fakeOutboxRelay: OutboxRelay = {
    status: {
      running: true,
      consecutiveFailures: 0,
      lastError: undefined,
    },
  } as unknown as OutboxRelay;

  it('GET /health retorna { status: "ok" }', () => {
    const controller = new HealthController(fakeDatabase, metrics, fakePublisher, fakeOutboxRelay);
    expect(controller.health()).toEqual({ status: 'ok' });
  });

  it('GET /ready retorna 200 con checks si la base de datos está ok', async () => {
    const controller = new HealthController(fakeDatabase, metrics, fakePublisher, fakeOutboxRelay);
    const res = await controller.ready();
    expect(res.status).toBe('ready');
    expect(res.checks.database.status).toBe('ok');
    expect(res.checks.kafka.status).toBe('ok');
    expect(res.checks.outbox.status).toBe('ok');
  });

  it('GET /ready lanza HttpException 503 si la base de datos cae', async () => {
    const failingDb = {
      ...fakeDatabase,
      ping: vi.fn().mockRejectedValue(new Error('Connection refused')),
    };
    const controller = new HealthController(failingDb, metrics, fakePublisher, fakeOutboxRelay);
    await expect(controller.ready()).rejects.toThrow(HttpException);
  });

  it('GET /metrics retorna métricas de Prometheus', async () => {
    const controller = new HealthController(fakeDatabase, metrics, fakePublisher, fakeOutboxRelay);
    const body = await controller.getMetrics();
    expect(typeof body).toBe('string');
  });
});
