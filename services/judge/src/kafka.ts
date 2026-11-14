import { Kafka, logLevel, Partitioners } from 'kafkajs';
import type { Consumer, LogEntry, Producer } from 'kafkajs';
import type { Logger } from './logger.js';

/** Adapta los logs de kafkajs a pino. */
export function kafkaLogCreator(logger: Logger) {
  const log = logger.child({ component: 'kafkajs' });
  return () =>
    ({ level, log: entry }: LogEntry) => {
      const { message, ...rest } = entry;
      const fields = { ...rest, kafkaNamespace: (entry as { namespace?: string }).namespace };
      switch (level) {
        case logLevel.ERROR:
          log.error(fields, message);
          break;
        case logLevel.WARN:
          log.warn(fields, message);
          break;
        case logLevel.INFO:
          log.info(fields, message);
          break;
        default:
          log.debug(fields, message);
      }
    };
}

export interface KafkaClients {
  consumer: Consumer;
  producer: Producer;
}

export interface KafkaSettings {
  brokers: string[];
  clientId: string;
  groupId: string;
}

export function createKafkaClients(settings: KafkaSettings, logger: Logger): KafkaClients {
  const kafka = new Kafka({
    clientId: settings.clientId,
    brokers: settings.brokers,
    logLevel: logLevel.INFO,
    logCreator: kafkaLogCreator(logger),
  });
  return {
    consumer: kafka.consumer({
      groupId: settings.groupId,
      sessionTimeout: 30_000,
      heartbeatInterval: 3_000,
    }),
    // Particionador compatible con Java (murmur2) de forma explícita.
    producer: kafka.producer({ createPartitioner: Partitioners.DefaultPartitioner }),
  };
}

/** Estado de conexión para /ready, alimentado por los eventos instrumentados de kafkajs. */
export class KafkaReadiness {
  producerConnected = false;
  consumerJoined = false;
  consumerCrashed = false;

  track({ consumer, producer }: KafkaClients): void {
    producer.on(producer.events.CONNECT, () => (this.producerConnected = true));
    producer.on(producer.events.DISCONNECT, () => (this.producerConnected = false));
    consumer.on(consumer.events.GROUP_JOIN, () => {
      this.consumerJoined = true;
      this.consumerCrashed = false;
    });
    consumer.on(consumer.events.CRASH, () => (this.consumerCrashed = true));
    consumer.on(consumer.events.STOP, () => (this.consumerJoined = false));
    consumer.on(consumer.events.DISCONNECT, () => (this.consumerJoined = false));
  }

  checks(): Record<string, boolean> {
    return {
      kafkaProducer: this.producerConnected,
      kafkaConsumer: this.consumerJoined && !this.consumerCrashed,
    };
  }
}
