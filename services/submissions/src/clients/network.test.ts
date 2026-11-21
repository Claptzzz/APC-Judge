// Sin mocks: transporte gRPC real de connect-node contra sockets locales, para comprobar que
// los fallos de red reales se clasifican como `unavailable`.
import { createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyUpstreamError } from './errors.js';
import { ConnectProblemsClient } from './problems.client.js';
import { ConnectRankingClient } from './ranking.client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('silent');

function listen(server: Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );
}

describe('clientes contra la red real', () => {
  let closedPort: number;
  let silentServer: Server;
  let silentPort: number;
  const sockets = new Set<Socket>();

  beforeAll(async () => {
    // Puerto que quedó libre: la conexión será rechazada (ECONNREFUSED).
    const tmp = createServer();
    closedPort = await listen(tmp);
    await new Promise((r) => tmp.close(r));

    // Servidor TCP que acepta la conexión pero nunca responde → vence el timeout.
    silentServer = createServer((s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    silentPort = await listen(silentServer);
  });

  afterAll(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => silentServer.close(r));
  });

  it('servicio caído (conexión rechazada) → unavailable', async () => {
    const client = new ConnectProblemsClient(`127.0.0.1:${closedPort}`, logger, 2000);
    const err = await client.getProblem('p').catch((e: unknown) => e);
    expect(err).toBeDefined();
    expect(classifyUpstreamError(err)).toBe('unavailable');
  });

  it('servicio que no responde → vence el timeout por llamada → unavailable', async () => {
    const client = new ConnectRankingClient(`127.0.0.1:${silentPort}`, logger, 200);
    const started = Date.now();
    const err = await client.getContest('c').catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(classifyUpstreamError(err)).toBe('unavailable');
  });
});
