import { mkdir } from 'node:fs/promises';
import { createClient } from '@connectrpc/connect';
import { Topics } from '@juez/contracts';
import { ProblemService } from '@juez/contracts/es';
import { loadConfig } from './config.js';
import { createHttpServer } from './http.js';
import { judgeSubmission } from './judge.js';
import { createKafkaClients, KafkaReadiness } from './kafka.js';
import { createLogger } from './logger.js';
import { Metrics } from './metrics.js';
import { createJudgeSpecSource, createProblemsTransport } from './problems-client.js';
import { detectSandbox } from './sandbox/capabilities.js';
import { downloadTestcases } from './testcases.js';
import { createMessageHandler } from './worker.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  if (config.concurrency !== 1) {
    logger.warn(
      { JUDGE_CONCURRENCY: config.concurrency },
      'JUDGE_CONCURRENCY se ignora: el judge procesa un mensaje a la vez por instancia y escala por réplicas',
    );
  }

  const sandbox = await detectSandbox();
  if (!sandbox.unshare) {
    logger.warn('unshare -rn no está disponible: los programas se ejecutan SIN aislamiento de red');
  }
  if (!sandbox.time) {
    logger.warn('GNU time (/usr/bin/time) no está disponible: no se mide la memoria máxima (RSS)');
  }
  logger.info({ sandbox }, 'sandbox detectado');
  await mkdir(config.workdir, { recursive: true });

  const problems = createJudgeSpecSource(
    createClient(ProblemService, createProblemsTransport(config.problemsBaseUrl)),
    { logger },
  );
  const metrics = new Metrics();
  const kafka = createKafkaClients(config.kafka, logger);
  const readiness = new KafkaReadiness();
  readiness.track(kafka);

  const server = createHttpServer({
    readiness: () => {
      const checks = readiness.checks();
      return { ready: Object.values(checks).every(Boolean), checks };
    },
    metrics: () => metrics.render(),
  });
  server.listen(config.httpPort, () => logger.info({ port: config.httpPort }, 'HTTP escuchando'));

  const handler = createMessageHandler({
    consumer: kafka.consumer,
    producer: kafka.producer,
    logger,
    metrics,
    judge: (submission, ctx) =>
      judgeSubmission(
        submission,
        {
          problems,
          download: (spec, dir) => downloadTestcases(spec, dir, { logger }),
          sandbox,
          settings: {
            workdir: config.workdir,
            compileTimeoutMs: config.compileTimeoutMs,
            maxOutputBytes: config.maxOutputBytes,
          },
          logger,
        },
        ctx,
      ),
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'apagando');
    const force = setTimeout(() => {
      logger.error('apagado forzado por timeout');
      process.exit(1);
    }, 30_000);
    force.unref();
    try {
      // disconnect espera a que termine el mensaje en curso; su offset solo se confirma si
      // alcanzó a publicarse el veredicto.
      await kafka.consumer.disconnect();
      await kafka.producer.disconnect();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      logger.info('apagado completo');
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'error al apagar');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await kafka.producer.connect();
  await kafka.consumer.connect();
  await kafka.consumer.subscribe({ topic: Topics.SUBMISSION_CREATED, fromBeginning: true });
  await kafka.consumer.run({
    autoCommit: false,
    // Un mensaje a la vez por instancia; se escala con réplicas (hasta 3 particiones).
    partitionsConsumedConcurrently: 1,
    eachMessage: handler,
  });
  logger.info(
    { groupId: config.kafka.groupId, topic: Topics.SUBMISSION_CREATED },
    'consumidor iniciado',
  );
}

main().catch((error: unknown) => {
  createLogger().fatal({ err: error }, 'el judge no pudo arrancar');
  process.exit(1);
});
