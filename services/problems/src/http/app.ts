import type { Server } from 'node:http';
import express, { type Express } from 'express';
import type { Registry } from 'prom-client';
import type { Logger } from '../logger.js';

export type ReadinessCheck = () => Promise<void>;

export interface HttpAppOptions {
  /** Dependencias que deben responder para que el servicio esté listo (BD, S3). */
  checks: Record<string, ReadinessCheck>;
  registry: Registry;
  logger: Logger;
  /** Tiempo máximo de cada chequeo de /ready. */
  checkTimeoutMs?: number;
}

function withTimeout(check: ReadinessCheck, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`sin respuesta en ${ms} ms`)), ms);
  });
  return Promise.race([check(), timeout]).finally(() => clearTimeout(timer));
}

/** Express solo atiende operación: /health, /ready y /metrics. gRPC va en su propio servidor. */
export function createHttpApp({
  checks,
  registry,
  logger,
  checkTimeoutMs = 2_000,
}: HttpAppOptions): Express {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/ready', async (_req, res) => {
    const entries = await Promise.all(
      Object.entries(checks).map(async ([name, check]) => {
        try {
          await withTimeout(check, checkTimeoutMs);
          return [name, 'ok'] as const;
        } catch (err) {
          logger.warn({ err, check: name }, 'chequeo de readiness falló');
          return [name, err instanceof Error ? err.message || err.name : 'error'] as const;
        }
      }),
    );
    const ok = entries.every(([, status]) => status === 'ok');
    res
      .status(ok ? 200 : 503)
      .json({ status: ok ? 'ok' : 'unavailable', checks: Object.fromEntries(entries) });
  });

  app.get('/metrics', async (_req, res) => {
    res.type(registry.contentType).send(await registry.metrics());
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  return app;
}

export function listen(app: Express, port: number, host?: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host ?? '0.0.0.0', (err?: Error) =>
      err ? reject(err) : resolve(server),
    );
  });
}

export function closeHttp(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections();
  });
}
