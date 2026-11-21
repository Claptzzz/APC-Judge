import { Kafka, logLevel, Partitioners } from 'kafkajs';
import type { Consumer, LogEntry, Producer } from 'kafkajs';
import type { Logger } from '../logger.js';

/** Adapta los logs de kafkajs a pino. */
export function kafkaLogCreator(logger: Logger) {
  const log = logger.child({ component: 'kafkajs' });
  return () =>
    ({ level, log: entry }: LogEntry) => {
      const { message, ...rest } = entry;
      switch (level) {
        case logLevel.ERROR:
          log.error(rest, message);
          break;
        case logLevel.WARN:
          log.warn(rest, message);
          break;
        case logLevel.INFO:
          log.info(rest, message);
          break;
        default:
          log.debug(rest, message);
      }
    };
}

export interface KafkaClients {
  consumer: Consumer;
  /** Solo para publicar en las DLQ. */
  producer: Producer;
}

export function createKafkaClients(
  settings: { brokers: string[]; clientId: string; groupId: string },
  logger: Logger,
): KafkaClients {
  const kafka = new Kafka({
    clientId: settings.clientId,
    brokers: settings.brokers,
    logLevel: logLevel.WARN,
    logCreator: kafkaLogCreator(logger),
    retry: { initialRetryTime: 300, maxRetryTime: 30_000, retries: 8 },
  });
  return {
    consumer: kafka.consumer({
      groupId: settings.groupId,
      sessionTimeout: 30_000,
      heartbeatInterval: 3_000,
    }),
    producer: kafka.producer({
      allowAutoTopicCreation: false,
      createPartitioner: Partitioners.DefaultPartitioner,
    }),
  };
}

/**
 * Estado del consumidor para /ready, alimentado por los eventos instrumentados de kafkajs
 * (mismo criterio que `KafkaReadiness` en services/judge/src/kafka.ts).
 */
export class ConsumerReadiness {
  joined = false;
  crashed = false;

  track(consumer: Consumer): void {
    consumer.on(consumer.events.GROUP_JOIN, () => {
      this.joined = true;
      this.crashed = false;
    });
    consumer.on(consumer.events.CRASH, () => (this.crashed = true));
    consumer.on(consumer.events.STOP, () => (this.joined = false));
    consumer.on(consumer.events.DISCONNECT, () => (this.joined = false));
  }

  get ready(): boolean {
    return this.joined && !this.crashed;
  }
}
