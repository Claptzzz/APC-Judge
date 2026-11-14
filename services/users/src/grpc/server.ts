import http2 from 'node:http2';
import type { ConnectRouter, Interceptor } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';

export interface GrpcServer {
  listen(port: number, host?: string): Promise<void>;
  /** Deja de aceptar conexiones y espera a que terminen las sesiones activas. */
  close(): Promise<void>;
  readonly server: http2.Http2Server;
}

/**
 * Servidor HTTP/2 sin TLS (h2c) separado de Fastify: los clientes @grpc/grpc-js (BFF) exigen
 * HTTP/2. connectNodeAdapter atiende los protocolos gRPC, gRPC-Web y Connect.
 */
export function createGrpcServer(
  routes: (router: ConnectRouter) => void,
  interceptors: Interceptor[] = [],
): GrpcServer {
  const server = http2.createServer(connectNodeAdapter({ routes, interceptors }));
  const sessions = new Set<http2.Http2Session>();
  server.on('session', (session) => {
    sessions.add(session);
    session.once('close', () => sessions.delete(session));
  });

  return {
    server,
    listen(port, host = '0.0.0.0') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        // GOAWAY a las sesiones abiertas: terminan sus streams en curso y se cierran.
        for (const session of sessions) session.close();
      });
    },
  };
}
