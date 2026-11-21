import { Inject, Module } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import kafkajs from 'kafkajs';
import { JwtVerifier } from './auth/jwt-verifier.js';
import { ConnectProblemsClient } from './clients/problems.client.js';
import { ConnectRankingClient } from './clients/ranking.client.js';
import type { Config } from './config.js';
import { createDatabase } from './db/client.js';
import type { Database } from './db/client.js';
import { SubmissionController } from './grpc/submission.controller.js';
import { HealthController } from './health/health.controller.js';
import { JudgedConsumer } from './kafka/judged.consumer.js';
import { createLogger } from './logger.js';
import type { Logger } from './logger.js';
import { createMetrics } from './metrics.js';
import { createKafka, KafkaEventPublisher } from './outbox/publisher.js';
import type { EventPublisher } from './outbox/publisher.js';
import { OutboxRelay } from './outbox/relay.js';
import { DrizzleOutboxStore } from './outbox/store.js';
import { DrizzleSubmissionsRepository } from './repository.js';

const { Partitioners } = kafkajs;

export interface AppModuleOptions {
  config: Config;
}

@Module({})
export class AppModule implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly jwtVerifier: JwtVerifier,
    @Inject('EventPublisher')
    private readonly publisher: EventPublisher,
    private readonly outboxRelay: OutboxRelay,
    private readonly judgedConsumer: JudgedConsumer,
    @Inject('Database')
    private readonly database: Database,
    @Inject('Logger')
    private readonly logger: Logger,
  ) {}

  static register(config: Config) {
    const logger = createLogger(config.logLevel);
    const metrics = createMetrics();
    const database = createDatabase(config.databaseUrl);
    const repo = new DrizzleSubmissionsRepository(database.db);

    const jwtVerifier = new JwtVerifier(
      config.grpcAddrs.users,
      config.jwt.issuer,
      config.jwt.audience,
      logger.child({ component: 'jwt' }),
    );

    const problemsClient = new ConnectProblemsClient(
      config.grpcAddrs.problems,
      logger.child({ component: 'problems-client' }),
    );

    const rankingClient = new ConnectRankingClient(
      config.grpcAddrs.ranking,
      logger.child({ component: 'ranking-client' }),
    );

    const kafka = createKafka(config.kafka.brokers, config.kafka.clientId, logger);
    const publisher = new KafkaEventPublisher(kafka);

    const outboxStore = new DrizzleOutboxStore(database.db);
    const outboxRelay = new OutboxRelay(outboxStore, publisher, {
      ...config.outbox,
      logger: logger.child({ component: 'outbox' }),
      onPublished: (n) => metrics.outboxPublished.inc(n),
    });

    const consumerKafka = createKafka(config.kafka.brokers, config.kafka.clientId, logger);
    const consumer = consumerKafka.consumer({
      groupId: config.kafka.groupId,
      sessionTimeout: 30_000,
      heartbeatInterval: 3_000,
    });
    const consumerProducer = consumerKafka.producer({
      createPartitioner: Partitioners.DefaultPartitioner,
    });

    const judgedConsumer = new JudgedConsumer({
      consumer,
      producer: consumerProducer,
      repo,
      logger: logger.child({ component: 'judged-consumer' }),
      metrics,
    });

    return {
      module: AppModule,
      controllers: [SubmissionController, HealthController],
      providers: [
        { provide: 'Config', useValue: config },
        { provide: 'Logger', useValue: logger },
        { provide: 'Metrics', useValue: metrics },
        { provide: 'Database', useValue: database },
        { provide: 'SubmissionsRepository', useValue: repo },
        { provide: 'JwtVerifier', useValue: jwtVerifier },
        { provide: 'ProblemsClient', useValue: problemsClient },
        { provide: 'RankingClient', useValue: rankingClient },
        { provide: 'EventPublisher', useValue: publisher },
        { provide: 'OutboxRelay', useValue: outboxRelay },
        { provide: 'JudgedConsumer', useValue: judgedConsumer },
        { provide: JwtVerifier, useValue: jwtVerifier },
        { provide: KafkaEventPublisher, useValue: publisher },
        { provide: OutboxRelay, useValue: outboxRelay },
        { provide: JudgedConsumer, useValue: judgedConsumer },
        { provide: 'DatabaseClient', useValue: database },
      ],
      exports: [
        'Config',
        'Logger',
        'Metrics',
        'Database',
        'SubmissionsRepository',
        'JwtVerifier',
        'ProblemsClient',
        'RankingClient',
        'EventPublisher',
        'OutboxRelay',
        'JudgedConsumer',
      ],
    };
  }

  async onModuleInit() {
    this.logger.info('inicializando AppModule...');
    // No bloquea el arranque: si users no responde, reintenta en segundo plano con backoff
    // y, mientras tanto, cada RPC intenta obtener la llave (UNAVAILABLE si users sigue caído).
    void this.jwtVerifier.init();
    // El relay conecta el productor en cada iteración y reintenta con backoff (tope 30 s); no
    // esperamos a Kafka aquí para no bloquear el arranque.
    this.outboxRelay.start();
    // No bloquea el arranque: si Kafka no está disponible, el consumidor reintenta en segundo
    // plano con backoff y /ready responde 503 hasta que se una al grupo.
    void this.judgedConsumer.start();
    this.logger.info('AppModule inicializado');
  }

  async onModuleDestroy() {
    this.logger.info('deteniendo AppModule...');
    this.jwtVerifier.stop();
    await this.judgedConsumer.stop().catch(() => {});
    await this.outboxRelay.stop().catch(() => {});
    await this.publisher.disconnect().catch(() => {});
    await this.database.close().catch(() => {});
    this.logger.info('AppModule detenido');
  }
}
