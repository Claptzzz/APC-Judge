import kafkajs from 'kafkajs';
import type { Kafka, LogEntry } from 'kafkajs';
import type { Logger } from '../logger.js';

const { Kafka: KafkaClient, logLevel } = kafkajs;

const LEVELS: Record<number, 'error' | 'warn' | 'info' | 'debug'> = {
  [logLevel.ERROR]: 'error',
  [logLevel.WARN]: 'warn',
  [logLevel.INFO]: 'info',
  [logLevel.DEBUG]: 'debug',
};

export function kafkaLogCreator(logger: Logger) {
  const log = logger.child({ component: 'kafkajs' });
  return () =>
    ({ level, log: entry }: LogEntry) => {
      const { message, ...extra } = entry;
      log[LEVELS[level] ?? 'info'](extra, message);
    };
}

export function createKafka(brokers: string[], clientId: string, logger: Logger): Kafka {
  return new KafkaClient({
    clientId,
    brokers,
    logLevel: logLevel.WARN,
    logCreator: kafkaLogCreator(logger),
  });
}
