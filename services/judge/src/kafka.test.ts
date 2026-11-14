import { EventEmitter } from 'node:events';
import { logLevel } from 'kafkajs';
import type { Consumer, Producer } from 'kafkajs';
import { describe, expect, it, vi } from 'vitest';
import { createKafkaClients, kafkaLogCreator, KafkaReadiness } from './kafka.js';
import { createLogger, SERVICE_NAME } from './logger.js';
import { silentLogger } from './test-utils/index.js';

describe('kafkaLogCreator', () => {
  it('mapea los niveles de kafkajs a pino', () => {
    const child = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const logger = { child: () => child } as unknown as typeof silentLogger;
    const log = kafkaLogCreator(logger)();
    const entry = (message: string) => ({
      namespace: 'Runner',
      label: 'X',
      log: { timestamp: 't', message, groupId: 'judge' },
    });
    log({ level: logLevel.ERROR, ...entry('e') });
    log({ level: logLevel.WARN, ...entry('w') });
    log({ level: logLevel.INFO, ...entry('i') });
    log({ level: logLevel.DEBUG, ...entry('d') });
    expect(child.error).toHaveBeenCalledWith(expect.objectContaining({ groupId: 'judge' }), 'e');
    expect(child.warn).toHaveBeenCalledWith(expect.any(Object), 'w');
    expect(child.info).toHaveBeenCalledWith(expect.any(Object), 'i');
    expect(child.debug).toHaveBeenCalledWith(expect.any(Object), 'd');
  });
});

describe('createKafkaClients', () => {
  it('crea consumer y producer sin conectarse', () => {
    const clients = createKafkaClients(
      { brokers: ['localhost:1'], clientId: 'judge', groupId: 'judge' },
      silentLogger,
    );
    expect(clients.consumer.events.GROUP_JOIN).toBeDefined();
    expect(clients.producer.events.CONNECT).toBeDefined();
  });
});

describe('KafkaReadiness', () => {
  function fakeClients() {
    const consumer = Object.assign(new EventEmitter(), {
      events: { GROUP_JOIN: 'join', CRASH: 'crash', STOP: 'stop', DISCONNECT: 'disconnect' },
    });
    const producer = Object.assign(new EventEmitter(), {
      events: { CONNECT: 'connect', DISCONNECT: 'disconnect' },
    });
    return {
      consumer: consumer as unknown as Consumer,
      producer: producer as unknown as Producer,
      raw: { consumer, producer },
    };
  }

  it('sigue la conexión del producer y la membresía del consumer', () => {
    const { consumer, producer, raw } = fakeClients();
    const readiness = new KafkaReadiness();
    readiness.track({ consumer, producer });
    expect(readiness.checks()).toEqual({ kafkaProducer: false, kafkaConsumer: false });

    raw.producer.emit('connect');
    raw.consumer.emit('join');
    expect(readiness.checks()).toEqual({ kafkaProducer: true, kafkaConsumer: true });

    raw.consumer.emit('crash');
    expect(readiness.checks().kafkaConsumer).toBe(false);
    raw.consumer.emit('join');
    expect(readiness.checks().kafkaConsumer).toBe(true);

    raw.consumer.emit('stop');
    raw.producer.emit('disconnect');
    expect(readiness.checks()).toEqual({ kafkaProducer: false, kafkaConsumer: false });
    raw.consumer.emit('join');
    raw.consumer.emit('disconnect');
    expect(readiness.checks().kafkaConsumer).toBe(false);
  });
});

describe('createLogger', () => {
  it('usa el nombre del servicio', () => {
    const logger = createLogger('warn');
    expect(logger.level).toBe('warn');
    expect(SERVICE_NAME).toBe('judge');
    expect(createLogger().level).toBe('info');
  });
});
