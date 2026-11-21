import { Hono } from 'hono';
import type { Registry } from '@prometheus-io/client';

export type Check = () => Promise<unknown> | unknown;

export interface CheckResult {
  status: 'ok' | 'down' | 'degraded';
  error?: string;
  [extra: string]: unknown;
}

export interface HttpAppOptions {
  registry: Registry;
  /** Dependencias obligatorias: si alguna falla, /ready responde 503. */
  readiness: Record<string, Check>;
  /**
   * Dependencias que degradan el servicio sin dejarlo fuera de servicio (Redis, proyección):
   * se reportan y ponen `status: degraded`, pero /ready sigue respondiendo 200.
   */
  degradable?: Record<string, () => Promise<CheckResult> | CheckResult>;
}

async function runCheck(check: Check): Promise<CheckResult> {
  try {
    await check();
    return { status: 'ok' };
  } catch (err) {
    return { status: 'down', error: err instanceof Error ? err.message : String(err) };
  }
}

async function runDegradable(
  check: () => Promise<CheckResult> | CheckResult,
): Promise<CheckResult> {
  try {
    return await check();
  } catch (err) {
    return { status: 'degraded', error: err instanceof Error ? err.message : String(err) };
  }
}

/** Hono solo para /health, /ready y /metrics (el gRPC va en un servidor HTTP/2 aparte). */
export function createHttpApp(opts: HttpAppOptions): Hono {
  const app = new Hono();

  app.get('/health', (c) => c.json({ status: 'ok' }));

  app.get('/ready', async (c) => {
    const required = Object.entries(opts.readiness);
    const degradable = Object.entries(opts.degradable ?? {});
    const [req, deg] = await Promise.all([
      Promise.all(required.map(async ([name, check]) => [name, await runCheck(check)] as const)),
      Promise.all(
        degradable.map(async ([name, check]) => [name, await runDegradable(check)] as const),
      ),
    ]);
    const ready = req.every(([, r]) => r.status === 'ok');
    const degraded = deg.some(([, r]) => r.status !== 'ok');
    const status = !ready ? 'not_ready' : degraded ? 'degraded' : 'ready';
    return c.json({ status, checks: Object.fromEntries([...req, ...deg]) }, ready ? 200 : 503);
  });

  app.get('/metrics', async (c) => {
    c.header('content-type', opts.registry.contentType);
    return c.body(await opts.registry.metrics());
  });

  app.notFound((c) => c.json({ error: 'not found' }, 404));
  return app;
}
