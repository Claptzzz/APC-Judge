import 'reflect-metadata';
import { createApp } from './app.js';
import { AssistantService } from './assistant/assistant.service.js';
import { GeminiChatModel } from './assistant/gemini.js';
import { HttpMcpConnector } from './assistant/mcp.js';
import { JwtVerifier } from './auth/jwt-verifier.js';
import { ConfigError, loadConfig } from './config.js';
import type { JudgedEvent } from './events/judged.js';
import { PubSub } from './events/pubsub.js';
import { createGrpcBackend } from './grpc/backend.js';
import { JudgedConsumer } from './kafka/judged.consumer.js';
import { createKafka } from './kafka/kafka.js';
import { createLogger } from './logger.js';
import { createMetrics } from './metrics.js';

async function bootstrap() {
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

  const metrics = createMetrics();
  const { backend, close: closeBackend } = createGrpcBackend(
    config.grpc,
    logger.child({ component: 'grpc' }),
  );
  const verifier = new JwtVerifier(
    backend.users,
    config.jwt.issuer,
    config.jwt.audience,
    logger.child({ component: 'jwt' }),
  );
  const pubsub = new PubSub<JudgedEvent>();
  const kafka = createKafka(config.kafka.brokers, config.kafka.clientId, logger);
  const consumer = new JudgedConsumer({
    consumer: kafka.consumer({
      groupId: config.kafka.groupId,
      sessionTimeout: 30_000,
      heartbeatInterval: 3_000,
    }),
    pubsub,
    logger: logger.child({ component: 'judged-consumer' }),
    metrics,
  });

  const { gemini, model, disabledReason } = config.assistant;
  if (!gemini) logger.warn({ reason: disabledReason }, 'asistente deshabilitado');
  const assistant = new AssistantService({
    model: gemini ? new GeminiChatModel(gemini, model) : undefined,
    mcp: new HttpMcpConnector(config.assistant.mcpUrl),
    logger: logger.child({ component: 'assistant' }),
    metrics,
    maxRounds: config.assistant.maxRounds,
    timeoutMs: config.assistant.timeoutMs,
    rateLimitPerMinute: config.assistant.rateLimitPerMinute,
  });

  try {
    const app = await createApp({
      config,
      logger,
      metrics,
      backend,
      verifier,
      pubsub,
      assistant,
      consumer,
      closeBackend,
    });
    await app.listen(config.port, '0.0.0.0');
    logger.info(
      {
        port: config.port,
        kafkaGroupId: config.kafka.groupId,
        assistant: gemini ? { mode: gemini.mode, model } : 'deshabilitado',
      },
      'bff listo',
    );
  } catch (err) {
    logger.fatal({ err }, 'no se pudo arrancar el bff');
    process.exit(1);
  }
}

void bootstrap();
