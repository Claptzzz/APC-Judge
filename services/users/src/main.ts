import { startApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createLogger } from './logger.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main() {
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
  process.on('unhandledRejection', (err) => {
    logger.fatal({ err }, 'unhandledRejection');
    process.exit(1);
  });

  let app;
  try {
    app = await startApp(config, logger);
  } catch (err) {
    logger.fatal({ err }, 'no se pudo arrancar');
    process.exit(1);
  }

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'señal recibida');
    const timer = setTimeout(() => {
      logger.error('apagado excedió el tiempo límite; forzando salida');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    app.stop().then(
      () => process.exit(0),
      (err: unknown) => {
        logger.error({ err }, 'error durante el apagado');
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

void main();
