import { describe, expect, it, vi } from 'vitest';
import { HealthController } from './health.controller.js';
import { createMetrics } from '../metrics.js';
import type { Database } from '../db/client.js';
import type { EventPublisher } from '../outbox/publisher.js';
import type { OutboxRelay } from '../outbox/relay.js';
import { ConsumerReadiness } from '../kafka/readiness.js';
import { HttpException, HttpStatus } from '@nestjs/common';

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

  const consumerWith = (joined: boolean, crashed: boolean) => {
    const readiness = new ConsumerReadiness();
    readiness.joined = joined;
    readiness.crashed = crashed;
    return { readiness };
  };
  const readyConsumer = consumerWith(true, false);

  const controllerWith = (
    overrides: { db?: Database; consumer?: { readiness: ConsumerReadiness } } = {},
  ) =>
    new HealthController(
      overrides.db ?? fakeDatabase,
      metrics,
      fakePublisher,
      fakeOutboxRelay,
      overrides.consumer ?? readyConsumer,
    );

  async function expect503(controller: HealthController) {
    const err = await controller.ready().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    return (err as HttpException).getResponse() as {
      status: string;
      checks: Record<string, { status: string }>;
    };
  }

  it('GET /health retorna { status: "ok" }', () => {
    const controller = controllerWith();
    expect(controller.health()).toEqual({ status: 'ok' });
  });

  it('GET /ready retorna 200 con checks si la base de datos está ok', async () => {
    const controller = controllerWith();
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
    const body = await expect503(controllerWith({ db: failingDb }));
    expect(body.checks.database?.status).toBe('down');
  });

  it('GET /ready incluye el check del consumidor cuando está unido al grupo', async () => {
    const res = await controllerWith().ready();
    expect(res.checks.judgedConsumer).toEqual({ status: 'ok', joined: true, crashed: false });
  });

  it('GET /ready responde 503 si el consumidor no está unido al grupo', async () => {
    const body = await expect503(controllerWith({ consumer: consumerWith(false, false) }));
    expect(body.status).toBe('not_ready');
    expect(body.checks.judgedConsumer?.status).toBe('down');
  });

  it('GET /ready responde 503 si el consumidor se cayó', async () => {
    const body = await expect503(controllerWith({ consumer: consumerWith(true, true) }));
    expect(body.checks.judgedConsumer).toEqual({ status: 'down', joined: true, crashed: true });
  });

  it('GET /metrics retorna métricas de Prometheus', async () => {
    const controller = controllerWith();
    const body = await controller.getMetrics();
    expect(typeof body).toBe('string');
  });
});
