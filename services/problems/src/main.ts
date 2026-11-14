import { JwtVerifier, usersPublicKeySource } from './auth/jwt.js';
import { ConfigError, grpcBaseUrl, loadConfig } from './config.js';
import { createDb, pingDb } from './db/database.js';
import { KyselyProblemsRepository } from './db/problems-repository.js';
import { ProblemCatalog } from './domain/problem-catalog.js';
import { observabilityInterceptor } from './grpc/interceptors.js';
import { createProblemServiceImpl } from './grpc/problem-service.js';
import { createGrpcServer } from './grpc/server.js';
import { closeHttp, createHttpApp, listen } from './http/app.js';
import { createLogger } from './logger.js';
import { createMetrics } from './metrics.js';
import { S3TestcaseStorage } from './storage/testcase-storage.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger(config.LOG_LEVEL);
  const metrics = createMetrics();
  const db = createDb(config.PROBLEMS_DATABASE_URL);
  const storage = S3TestcaseStorage.fromConfig(config);
  const verifier = new JwtVerifier(usersPublicKeySource(grpcBaseUrl(config.USERS_GRPC_ADDR)), {
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
    logger,
  });
  const catalog = new ProblemCatalog({ repo: new KyselyProblemsRepository(db), storage, logger });

  const grpc = createGrpcServer(createProblemServiceImpl(catalog, verifier), [
    observabilityInterceptor(logger, metrics),
  ]);
  const app = createHttpApp({
    checks: { database: () => pingDb(db), storage: () => storage.ping() },
    registry: metrics.registry,
    logger,
  });

  const httpServer = await listen(app, config.PROBLEMS_HTTP_PORT);
  await grpc.listen(config.PROBLEMS_GRPC_PORT);
  logger.info(
    { httpPort: config.PROBLEMS_HTTP_PORT, grpcPort: config.PROBLEMS_GRPC_PORT },
    'problems escuchando',
  );

  // La llave pública se carga al arrancar; si users aún no está, se pide en la primera RPC autenticada.
  void verifier.warmUp();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'apagando');
    const force = setTimeout(() => {
      logger.error('apagado forzado por timeout');
      process.exit(1);
    }, 15_000);
    force.unref();
    try {
      await Promise.all([grpc.close(), closeHttp(httpServer)]);
      await db.destroy();
      storage.destroy();
      logger.info('apagado ordenado completo');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error durante el apagado');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error('problems no pudo arrancar', err);
  process.exit(1);
});
