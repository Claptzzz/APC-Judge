import kafkajs from 'kafkajs';
import type { Kafka, LogEntry, Producer } from 'kafkajs';
import type { Logger } from '../logger.js';
import type { OutboxMessage } from './store.js';

const { Kafka: KafkaClient, Partitioners, logLevel } = kafkajs;

export interface EventPublisher {
  connect(): Promise<void>;
  publish(messages: OutboxMessage[]): Promise<void>;
  isConnected(): boolean;
  disconnect(): Promise<void>;
}

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

export class KafkaEventPublisher implements EventPublisher {
  private readonly producer: Producer;
  private connected = false;

  constructor(kafka: Kafka) {
    this.producer = kafka.producer({
      idempotent: true,
      maxInFlightRequests: 1,
      createPartitioner: Partitioners.DefaultPartitioner,
    });
    this.producer.on(this.producer.events.CONNECT, () => {
      this.connected = true;
    });
    this.producer.on(this.producer.events.DISCONNECT, () => {
      this.connected = false;
    });
  }

  async connect(): Promise<void> {
    if (!this.connected) await this.producer.connect();
  }

  isConnected(): boolean {
    return this.connected;
  }

  async publish(messages: OutboxMessage[]): Promise<void> {
    const byTopic = new Map<string, OutboxMessage[]>();
    for (const m of messages) byTopic.set(m.topic, [...(byTopic.get(m.topic) ?? []), m]);
    await this.producer.sendBatch({
      acks: -1,
      topicMessages: [...byTopic].map(([topic, msgs]) => ({
        topic,
        messages: msgs.map((m) => ({ key: m.key, value: m.value, headers: m.headers })),
      })),
    });
  }

  async disconnect(): Promise<void> {
    await this.producer.disconnect();
  }
}
