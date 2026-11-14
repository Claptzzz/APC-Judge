import { describe, expect, it, vi } from 'vitest';
import { kafkaLogCreator, KafkaEventPublisher } from './publisher.js';
import type { EventPublisher } from './publisher.js';
import { OutboxRelay } from './relay.js';
import { DrizzleOutboxStore } from './store.js';
import type { OutboxMessage, OutboxStore } from './store.js';
import { createLogger } from '../logger.js';
import { chainFake } from '../test-utils/helpers.js';

const silentLogger = createLogger('silent');

const msg = (id: number, topic = 'submission.created'): OutboxMessage => ({
  id,
  topic,
  key: `k${id}`,
  value: Buffer.from([id]),
  headers: { 'event-id': `e${id}` },
});

class FakeStore implements OutboxStore {
  pending: OutboxMessage[] = [];
  published: OutboxMessage[] = [];
  async publishPending(limit: number, publish: (m: OutboxMessage[]) => Promise<void>) {
    const batch = this.pending.slice(0, limit);
    if (batch.length === 0) return 0;
    await publish(batch);
    this.pending = this.pending.slice(batch.length);
    this.published.push(...batch);
    return batch.length;
  }
}

class FakePublisher implements EventPublisher {
  sent: OutboxMessage[][] = [];
  connects = 0;
  failNext = 0;
  connected = false;
  async connect() {
    this.connects++;
    this.connected = true;
  }
  async publish(m: OutboxMessage[]) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('broker caído');
    }
    this.sent.push(m);
  }
  isConnected() {
    return this.connected;
  }
  async disconnect() {
    this.connected = false;
  }
}

describe('OutboxRelay', () => {
  it('runOnce conecta, publica un lote y notifica', async () => {
    const store = new FakeStore();
    store.pending = [msg(1), msg(2), msg(3)];
    const publisher = new FakePublisher();
    const onPublished = vi.fn();
    const relay = new OutboxRelay(store, publisher, {
      pollIntervalMs: 10,
      batchSize: 2,
      logger: silentLogger,
      onPublished,
    });
    expect(await relay.runOnce()).toBe(2);
    expect(await relay.runOnce()).toBe(1);
    expect(await relay.runOnce()).toBe(0);
    expect(publisher.sent.map((b) => b.map((m) => m.id))).toEqual([[1, 2], [3]]);
    expect(onPublished.mock.calls).toEqual([[2], [1]]);
  });

  it('reintenta con backoff si publicar falla', async () => {
    const store = new FakeStore();
    store.pending = [msg(1)];
    const publisher = new FakePublisher();
    publisher.failNext = 1;
    const relay = new OutboxRelay(store, publisher, {
      pollIntervalMs: 5,
      batchSize: 10,
      maxBackoffMs: 20,
      logger: silentLogger,
    });
    relay.start();
    await vi.waitFor(() => expect(store.published.map((m) => m.id)).toEqual([1]), {
      timeout: 2000,
    });
    expect(relay.status.consecutiveFailures).toBe(0);
    await relay.stop();
  });

  it('expone el último error mientras falla', async () => {
    const store = new FakeStore();
    store.pending = [msg(1)];
    const publisher = new FakePublisher();
    publisher.failNext = 1000;
    const relay = new OutboxRelay(store, publisher, {
      pollIntervalMs: 1000,
      batchSize: 10,
      logger: silentLogger,
    });
    relay.start();
    await vi.waitFor(() => expect(relay.status.consecutiveFailures).toBeGreaterThan(0));
    expect(relay.status.lastError).toBe('broker caído');
    await relay.stop();
  });
});

describe('DrizzleOutboxStore', () => {
  it('bloquea con FOR UPDATE SKIP LOCKED, publica y marca como publicado', async () => {
    const rows = [msg(1), msg(2)];
    const { chain, calls } = chainFake([rows, undefined]);
    const db = { transaction: (fn: (tx: unknown) => unknown) => fn(chain) };
    const publish = vi.fn(async () => {});
    const n = await new DrizzleOutboxStore(db as never).publishPending(50, publish);
    expect(n).toBe(2);
    expect(publish).toHaveBeenCalledWith(rows);
    expect(calls.find((c) => c.method === 'for')?.args).toEqual(['update', { skipLocked: true }]);
    expect(calls.find((c) => c.method === 'limit')?.args).toEqual([50]);
  });

  it('sin pendientes no publica ni actualiza', async () => {
    const { chain, calls } = chainFake([[]]);
    const db = { transaction: (fn: (tx: unknown) => unknown) => fn(chain) };
    const publish = vi.fn();
    expect(await new DrizzleOutboxStore(db as never).publishPending(10, publish)).toBe(0);
    expect(publish).not.toHaveBeenCalled();
    expect(calls.some((c) => c.method === 'update')).toBe(false);
  });
});

describe('KafkaEventPublisher', () => {
  function fakeKafka() {
    const handlers: Record<string, () => void> = {};
    const producer = {
      events: { CONNECT: 'connect', DISCONNECT: 'disconnect' },
      on: (event: string, fn: () => void) => (handlers[event] = fn),
      connect: vi.fn(async () => handlers.connect?.()),
      disconnect: vi.fn(async () => handlers.disconnect?.()),
      sendBatch: vi.fn(async () => []),
    };
    const kafka = { producer: vi.fn(() => producer) };
    return { kafka, producer };
  }

  it('usa productor idempotente, conecta una sola vez y agrupa por topic', async () => {
    const { kafka, producer } = fakeKafka();
    const pub = new KafkaEventPublisher(kafka as never);
    expect(pub.isConnected()).toBe(false);
    await pub.connect();
    expect(producer.connect).toHaveBeenCalledTimes(1);
    expect(pub.isConnected()).toBe(true);

    await pub.publish([msg(1, 'a'), msg(2, 'b'), msg(3, 'a')]);
    expect(producer.sendBatch).toHaveBeenCalledWith({
      acks: -1,
      topicMessages: [
        {
          topic: 'a',
          messages: [
            { key: 'k1', value: Buffer.from([1]), headers: { 'event-id': 'e1' } },
            { key: 'k3', value: Buffer.from([3]), headers: { 'event-id': 'e3' } },
          ],
        },
        {
          topic: 'b',
          messages: [{ key: 'k2', value: Buffer.from([2]), headers: { 'event-id': 'e2' } }],
        },
      ],
    });
    await pub.disconnect();
    expect(pub.isConnected()).toBe(false);
  });

  it('redirige los logs de kafkajs a pino', () => {
    const log = kafkaLogCreator(silentLogger)();
    expect(() =>
      log({
        namespace: 'x',
        level: 1,
        label: 'ERROR',
        log: { message: 'boom', broker: 'b:9092', timestamp: 't' },
      }),
    ).not.toThrow();
  });
});
