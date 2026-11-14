import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpServer } from './http.js';
import type { ReadinessReport } from './http.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
});

async function start(readiness: () => ReadinessReport, metrics?: () => string) {
  const server = createHttpServer({ readiness, metrics });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  close = () => new Promise((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('createHttpServer', () => {
  it('/health responde ok y /ready refleja las dependencias', async () => {
    let ready = false;
    const url = await start(
      () => ({ ready, checks: { kafkaConsumer: ready } }),
      () => 'm 1\n',
    );

    const health = await fetch(`${url}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });

    const notReady = await fetch(`${url}/ready`);
    expect(notReady.status).toBe(503);
    expect(await notReady.json()).toEqual({
      status: 'unavailable',
      checks: { kafkaConsumer: false },
    });

    ready = true;
    const okReady = await fetch(`${url}/ready?x=1`);
    expect(okReady.status).toBe(200);

    const metrics = await fetch(`${url}/metrics`);
    expect(metrics.headers.get('content-type')).toMatch(/text\/plain/);
    expect(await metrics.text()).toBe('m 1\n');
  });

  it('404 para rutas desconocidas y 405 para otros métodos', async () => {
    const url = await start(() => ({ ready: true, checks: {} }));
    expect((await fetch(`${url}/nada`)).status).toBe(404);
    expect((await fetch(`${url}/metrics`)).status).toBe(404);
    expect((await fetch(`${url}/health`, { method: 'POST' })).status).toBe(405);
  });
});
