import { createUsersKeyClient, JwtVerifier } from './auth/jwt.js';
import { ConfigError, loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createApp } from './server.js';
import { createUpstreamClients } from './upstream/clients.js';

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      createLogger('error').fatal({ issues: err.issues }, 'configuración inválida');
      process.exit(1);
    }
    throw err;
  }
  const logger = createLogger(config.logLevel);

  const verifier = new JwtVerifier(createUsersKeyClient(config.baseUrls.users), {
    issuer: config.jwt.issuer,
    audience: config.jwt.audience,
    timeoutMs: config.upstreamTimeoutMs,
    logger: logger.child({ component: 'jwt' }),
  });
  const app = createApp({
    verifier,
    clients: createUpstreamClients(config.baseUrls),
    logger,
    allowedHosts: config.allowedHosts,
    allowedOrigins: config.allowedOrigins,
    maxBodyBytes: config.maxBodyBytes,
    upstreamTimeoutMs: config.upstreamTimeoutMs,
  });

  app.server.listen(config.port, config.host, () =>
    logger.info(
      { port: config.port, host: config.host, allowedHosts: config.allowedHosts },
      'mcp escuchando',
    ),
  );
  // No bloquea el arranque: si users no responde, reintenta en segundo plano con backoff;
  // /ready responde 503 hasta tener la llave.
  void verifier.init();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'apagando');
    const force = setTimeout(() => {
      logger.error('apagado forzado por timeout');
      process.exit(1);
    }, 10_000);
    force.unref();
    verifier.stop();
    try {
      await app.close();
      logger.info('apagado completo');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error al apagar');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main();
