import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createMetrics } from '../metrics.js';
import { silentLogger } from '../test-utils/fakes.js';
import { closeHttp, createHttpApp, listen, type ReadinessCheck } from './app.js';

let server: Server | undefined;

async function start(
  checks: Record<string, ReadinessCheck>,
  checkTimeoutMs?: number,
): Promise<string> {
  const metrics = createMetrics({ defaultMetrics: false });
  metrics.rpcHandled.inc({ method: 'm', code: 'ok' });
  server = await listen(
    createHttpApp({ checks, registry: metrics.registry, logger: silentLogger, checkTimeoutMs }),
    0,
    '127.0.0.1',
  );
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  if (server) await closeHttp(server);
  server = undefined;
});

describe('HTTP de operación', () => {
  it('/health responde siempre', async () => {
    const base = await start({});
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  it('/ready OK cuando todas las dependencias responden', async () => {
    const base = await start({
      database: () => Promise.resolve(),
      storage: () => Promise.resolve(),
    });
    const res = await fetch(`${base}/ready`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', checks: { database: 'ok', storage: 'ok' } });
  });

  it('/ready 503 si una dependencia falla o no responde a tiempo', async () => {
    const base = await start(
      {
        database: () => Promise.reject(new Error('ECONNREFUSED')),
        storage: () => new Promise(() => {}),
        other: () => Promise.reject(new Error('')),
      },
      50,
    );
    const res = await fetch(`${base}/ready`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      status: 'unavailable',
      checks: { database: 'ECONNREFUSED', storage: 'sin respuesta en 50 ms', other: 'Error' },
    });
  });

  it('/metrics expone formato Prometheus', async () => {
    const base = await start({});
    const res = await fetch(`${base}/metrics`);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toContain(
      'grpc_server_handled_total{method="m",code="ok",service="problems"} 1',
    );
  });

  it('404 para el resto', async () => {
    const base = await start({});
    expect((await fetch(`${base}/nada`)).status).toBe(404);
  });
});
