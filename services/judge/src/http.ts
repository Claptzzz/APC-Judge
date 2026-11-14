import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';

export interface ReadinessReport {
  ready: boolean;
  checks: Record<string, boolean>;
}

export interface HttpDeps {
  readiness: () => ReadinessReport;
  metrics?: () => string;
}

/** Servidor `node:http` mínimo: /health (vivo), /ready (dependencias OK) y /metrics. */
export function createHttpServer(deps: HttpDeps): Server {
  return createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    if (path === '/health') {
      sendJson(res, 200, { status: 'ok' });
    } else if (path === '/ready') {
      const report = deps.readiness();
      sendJson(res, report.ready ? 200 : 503, {
        status: report.ready ? 'ok' : 'unavailable',
        checks: report.checks,
      });
    } else if (path === '/metrics' && deps.metrics) {
      res
        .writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' })
        .end(deps.metrics());
    } else {
      sendJson(res, 404, { error: 'not found' });
    }
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res
    .writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    .end(JSON.stringify(body));
}
