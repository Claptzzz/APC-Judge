import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { RankingService } from '@juez/contracts/es';
import { JwtVerifier, usersPublicKeySource } from './auth/jwt.js';
import { ConnectProblemsGateway } from './clients/problems.js';
import type { Config } from './config.js';
import { createDatabase } from './db/client.js';
import type { Database } from './db/client.js';
import { EventProcessor } from './events/processor.js';
import { requestContextInterceptor } from './grpc/interceptors.js';
import { createRankingServiceImpl } from './grpc/ranking-service.js';
import { createGrpcServer } from './grpc/server.js';
import type { GrpcServer } from './grpc/server.js';
import { createHttpApp } from './http/app.js';
import { RankingConsumer } from './kafka/consumer.js';
import { createKafkaClients } from './kafka/kafka.js';
import type { Logger } from './logger.js';
import { createMetrics } from './metrics.js';
import { ScoreboardProjector } from './projection/projector.js';
import { createRedis, ioredisAdapter } from './projection/redis.js';
import { ScoreboardStore } from './projection/scoreboard-store.js';
import { DrizzleRankingRepository } from './repository.js';

export interface App {
  ports: { http: number; grpc: number };
  stop(): Promise<void>;
}

function closeHttp(server: ServerType | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!server?.listening) return resolve();
    server.close(() => resolve());
    if ('closeAllConnections' in server) server.closeAllConnections();
  });
}

/**
 * Raíz de composición. Ninguna dependencia bloquea el arranque: Postgres se conecta en la
 * primera consulta, Redis y Kafka reintentan en segundo plano con backoff (tope 30 s) y la
 * llave pública de users se pide sin esperar. /ready refleja el estado real.
 * Las migraciones se aplican aparte con `pnpm db:migrate`.
 */
export async function startApp(config: Config, logger: Logger): Promise<App> {
  const metrics = createMetrics();
  const database: Database = createDatabase(config.databaseUrl);
  const repo = new DrizzleRankingRepository(database.db);
  const redis = createRedis(config.redisUrl, logger);
  const store = new ScoreboardStore(ioredisAdapter(redis));
  const projector = new ScoreboardProjector(
    repo,
    store,
    logger.child({ component: 'projection' }),
    metrics,
  );
  const verifier = new JwtVerifier(usersPublicKeySource(config.usersBaseUrl), {
    issuer: config.jwt.issuer,
    audience: config.jwt.audience,
    logger: logger.child({ component: 'jwt' }),
  });
  const kafka = createKafkaClients(config.kafka, logger);
  const consumer = new RankingConsumer({
    ...kafka,
    processor: new EventProcessor({ repo, projector, logger }),
    logger: logger.child({ component: 'consumer' }),
    metrics,
  });

  let grpc: GrpcServer | undefined;
  let http: ServerType | undefined;

  const stop = async () => {
    logger.info('apagando…');
    // 1) dejar de aceptar tráfico, 2) detener consumidor y tareas de fondo, 3) cerrar pools.
    await Promise.allSettled([grpc?.close(), closeHttp(http)]);
    await consumer.stop();
    verifier.stop();
    projector.stop();
    redis.disconnect();
    await database.close().catch((err: unknown) => logger.warn({ err }, 'cierre de la BD'));
    logger.info('apagado completo');
  };

  try {
    const app = createHttpApp({
      registry: metrics.registry,
      readiness: {
        database: () => database.ping(),
        kafkaConsumer: () => {
          if (!consumer.readiness.ready) {
            throw new Error(
              consumer.readiness.crashed ? 'consumidor caído' : 'consumidor no unido al grupo',
            );
          }
        },
      },
      degradable: {
        redis: async () => {
          await store.ping();
          return { status: 'ok' };
        },
        projection: () => {
          const s = projector.status();
          return s.degraded ? { status: 'degraded', ...s, error: s.lastError } : { status: 'ok' };
        },
        usersPublicKey: () =>
          verifier.hasKey ? { status: 'ok' } : { status: 'degraded', error: 'llave no cargada' },
      },
    });

    const httpPort = await new Promise<number>((resolve, reject) => {
      const server = serve(
        { fetch: app.fetch, port: config.httpPort, hostname: '0.0.0.0' },
        (info) => resolve(info.port),
      );
      server.once('error', reject);
      http = server;
    });

    grpc = createGrpcServer(
      (router) =>
        router.service(
          RankingService,
          createRankingServiceImpl({
            repo,
            projector,
            verifier,
            problems: ConnectProblemsGateway.fromBaseUrl(config.problemsBaseUrl),
          }),
        ),
      [requestContextInterceptor(logger, metrics)],
    );
    const grpcPort = await grpc.listen(config.grpcPort);

    void verifier.start();
    void consumer.start();

    const ports = { http: httpPort, grpc: grpcPort };
    logger.info({ ports }, 'ranking listo');
    return { ports, stop };
  } catch (err) {
    await stop().catch(() => {});
    throw err;
  }
}
