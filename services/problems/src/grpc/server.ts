import http2 from 'node:http2';
import type { Interceptor, ServiceImpl } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { ProblemService } from '@juez/contracts/es';

export interface GrpcServer {
  server: http2.Http2Server;
  listen(port: number, host?: string): Promise<number>;
  close(timeoutMs?: number): Promise<void>;
}

/**
 * Servidor HTTP/2 sin TLS (h2c) para gRPC, separado de Express. connectNodeAdapter atiende
 * gRPC (clientes @grpc/grpc-js de Nest), gRPC-web y Connect.
 */
export function createGrpcServer(
  impl: ServiceImpl<typeof ProblemService>,
  interceptors: Interceptor[],
): GrpcServer {
  const handler = connectNodeAdapter({
    routes: (router) => router.service(ProblemService, impl),
    interceptors,
  });
  const server = http2.createServer(handler);
  const sessions = new Set<http2.ServerHttp2Session>();
  server.on('session', (session) => {
    sessions.add(session);
    session.once('close', () => sessions.delete(session));
  });

  return {
    server,
    listen: (port, host) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          const address = server.address();
          resolve(typeof address === 'object' && address ? address.port : port);
        });
      }),
    close: (timeoutMs = 10_000) =>
      new Promise((resolve) => {
        if (!server.listening) return resolve();
        // Deja de aceptar conexiones y pide a cada sesión que termine sus streams (GOAWAY).
        const timer = setTimeout(() => {
          for (const session of sessions) session.destroy();
        }, timeoutMs);
        timer.unref();
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
        for (const session of sessions) session.close();
      }),
  };
}
