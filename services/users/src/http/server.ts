import Fastify, { LogController } from 'fastify';
import type { Logger } from '../logger.js';
import type { Metrics } from '../metrics.js';

export type Check = () => Promise<void>;

export interface HttpServerOptions {
  logger: Logger;
  metrics: Metrics;
  /** Dependencias obligatorias: si alguna falla, /ready responde 503. */
  readiness: Record<string, Check>;
  /** Dependencias informativas: se reportan, pero no cambian el estado. */
  informational?: Record<string, Check>;
}

async function runChecks(checks: Record<string, Check>) {
  const entries = await Promise.all(
    Object.entries(checks).map(async ([name, check]) => {
      try {
        await check();
        return [name, { status: 'ok' }] as const;
      } catch (err) {
        return [name, { status: 'down', error: (err as Error).message }] as const;
      }
    }),
  );
  return Object.fromEntries(entries) as Record<string, { status: 'ok' | 'down'; error?: string }>;
}

/** Fastify solo para health, readiness y métricas (el gRPC va en un servidor HTTP/2 aparte). */
export function createHttpServer(opts: HttpServerOptions) {
  const app = Fastify({
    loggerInstance: opts.logger,
    // Sin una línea de log por request: los sondeos de health/ready/metrics son ruido.
    logController: new LogController({ disableRequestLogging: true }),
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/ready', async (_req, reply) => {
    const [required, info] = await Promise.all([
      runChecks(opts.readiness),
      runChecks(opts.informational ?? {}),
    ]);
    const ready = Object.values(required).every((c) => c.status === 'ok');
    return reply
      .code(ready ? 200 : 503)
      .send({ status: ready ? 'ready' : 'not_ready', checks: { ...required, ...info } });
  });

  app.get('/metrics', async (_req, reply) => {
    return reply
      .type(opts.metrics.registry.contentType)
      .send(await opts.metrics.registry.metrics());
  });

  return app;
}

export type HttpServer = ReturnType<typeof createHttpServer>;
