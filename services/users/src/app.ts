import { UserService } from '@juez/contracts/es';
import { loadSigningKeys } from './auth/keys.js';
import { TokenService } from './auth/tokens.js';
import { ensureAdmin } from './bootstrap.js';
import type { Config } from './config.js';
import { createDatabase } from './db/client.js';
import type { Database } from './db/client.js';
import { requestContextInterceptor } from './grpc/interceptors.js';
import { createGrpcServer } from './grpc/server.js';
import type { GrpcServer } from './grpc/server.js';
import { createUserServiceImpl } from './grpc/user-service.js';
import { createHttpServer } from './http/server.js';
import type { HttpServer } from './http/server.js';
import type { Logger } from './logger.js';
import { createMetrics } from './metrics.js';
import { createKafka, KafkaEventPublisher } from './outbox/publisher.js';
import type { EventPublisher } from './outbox/publisher.js';
import { OutboxRelay } from './outbox/relay.js';
import { DrizzleOutboxStore } from './outbox/store.js';
import { DrizzleUsersRepository } from './repository.js';

export interface App {
  /** Puertos efectivos (útil con puerto 0 en tests). */
  ports: { http: number; grpc: number };
  stop(): Promise<void>;
}

/**
 * Raíz de composición: carga llaves, abre la BD, crea el admin inicial, arranca el relay
 * del outbox y los servidores HTTP (Fastify) y gRPC (Connect sobre HTTP/2).
 * Las migraciones se aplican aparte con `pnpm db:migrate`.
 */
export async function startApp(config: Config, logger: Logger): Promise<App> {
  const keys = await loadSigningKeys(config.jwt.privateKeyPath, config.jwt.publicKeyPath);
  const tokens = new TokenService({
    keys,
    keyId: config.jwt.keyId,
    issuer: config.jwt.issuer,
    audience: config.jwt.audience,
    ttlSeconds: config.jwt.ttlSeconds,
  });
  const metrics = createMetrics();

  let database: Database | undefined;
  let publisher: EventPublisher | undefined;
  let relay: OutboxRelay | undefined;
  let http: HttpServer | undefined;
  let grpc: GrpcServer | undefined;

  const stop = async () => {
    logger.info('apagando…');
    // 1) dejar de aceptar tráfico, 2) detener el relay, 3) cerrar Kafka y la BD.
    await Promise.allSettled([grpc?.close(), http?.close()]);
    await relay?.stop();
    await publisher?.disconnect().catch((err: unknown) => logger.warn({ err }, 'kafka disconnect'));
    await database?.close();
    logger.info('apagado completo');
  };

  try {
    database = createDatabase(config.databaseUrl);
    await database.ping(5000);
    const repo = new DrizzleUsersRepository(database.db);

    await ensureAdmin({ repo, logger }, config.admin);

    publisher = new KafkaEventPublisher(
      createKafka(config.kafka.brokers, config.kafka.clientId, logger),
    );
    relay = new OutboxRelay(new DrizzleOutboxStore(database.db), publisher, {
      ...config.outbox,
      logger: logger.child({ component: 'outbox' }),
      onPublished: (n) => metrics.outboxPublished.inc(n),
    });
    relay.start();

    const db = database;
    const kafka = publisher;
    const outboxRelay = relay;
    http = createHttpServer({
      logger,
      metrics,
      readiness: { database: () => db.ping() },
      // El outbox desacopla el registro de Kafka: si Kafka cae, users sigue atendiendo y
      // los eventos quedan pendientes. Por eso Kafka es informativo y no bloquea /ready.
      informational: {
        kafka: async () => {
          if (!kafka.isConnected()) throw new Error('productor desconectado');
        },
        outbox: async () => {
          const { consecutiveFailures, lastError } = outboxRelay.status;
          if (consecutiveFailures > 0) throw new Error(lastError ?? 'error al publicar');
        },
      },
    });
    await http.listen({ port: config.httpPort, host: '0.0.0.0' });

    grpc = createGrpcServer(
      (router) => router.service(UserService, createUserServiceImpl({ repo, tokens })),
      [requestContextInterceptor(logger, metrics)],
    );
    await grpc.listen(config.grpcPort);

    const httpAddress = http.server.address();
    const grpcAddress = grpc.server.address();
    const ports = {
      http: typeof httpAddress === 'object' && httpAddress ? httpAddress.port : config.httpPort,
      grpc: typeof grpcAddress === 'object' && grpcAddress ? grpcAddress.port : config.grpcPort,
    };
    logger.info({ ports, keyId: config.jwt.keyId }, 'users listo');
    return { stop, ports };
  } catch (err) {
    await stop().catch(() => {});
    throw err;
  }
}
