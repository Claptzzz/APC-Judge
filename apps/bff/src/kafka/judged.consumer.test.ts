import { EventEmitter } from 'node:events';
import { encodeEvent, Topics } from '@juez/contracts';
import { create, toBinary } from '@bufbuild/protobuf';
import { SubmissionJudgedSchema, Verdict } from '@juez/contracts/es';
import type { Consumer, EachMessagePayload } from 'kafkajs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scoreboardChannel, submissionChannel } from '../events/judged.js';
import type { JudgedEvent } from '../events/judged.js';
import { PubSub } from '../events/pubsub.js';
import { createMetrics } from '../metrics.js';
import { silentLogger } from '../test-utils/fixtures.js';
import { JudgedConsumer } from './judged.consumer.js';

const EVENTS = {
  GROUP_JOIN: 'consumer.group_join',
  CRASH: 'consumer.crash',
  STOP: 'consumer.stop',
  DISCONNECT: 'consumer.disconnect',
} as const;

function fakeConsumer() {
  const emitter = new EventEmitter();
  let eachMessage: ((p: EachMessagePayload) => Promise<void>) | undefined;
  const consumer = {
    events: EVENTS,
    on: (event: string, listener: (e: unknown) => void) => emitter.on(event, listener),
    connect: vi.fn(async () => {}),
    subscribe: vi.fn(async () => {}),
    run: vi.fn(async (opts: { eachMessage: typeof eachMessage }) => {
      eachMessage = opts.eachMessage;
    }),
    commitOffsets: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
  };
  return {
    consumer,
    emit: (event: string, payload: unknown = {}) => emitter.emit(event, { payload }),
    deliver: (value: Buffer | null, offset = '7') =>
      eachMessage!({
        topic: Topics.SUBMISSION_JUDGED,
        partition: 1,
        message: {
          key: null,
          value,
          offset,
          headers: {},
          timestamp: '0',
          attributes: 0,
        } as unknown as EachMessagePayload['message'],
        heartbeat: async () => {},
        pause: () => () => {},
      }),
  };
}

const judged = (overrides: Record<string, unknown> = {}) =>
  encodeEvent(Topics.SUBMISSION_JUDGED, {
    eventId: 'e1',
    submissionId: 's1',
    userId: 'u1',
    problemId: 'p1',
    verdict: Verdict.WRONG_ANSWER,
    timeMs: 10,
    memoryKb: 2048,
    passedCases: 1,
    totalCases: 3,
    occurredAt: { seconds: 1_763_820_000n, nanos: 5_000_000 },
    ...overrides,
  }).value;

function setup() {
  const fake = fakeConsumer();
  const pubsub = new PubSub<JudgedEvent>();
  const metrics = createMetrics({ defaultMetrics: false });
  const c = new JudgedConsumer(
    { consumer: fake.consumer as unknown as Consumer, pubsub, logger: silentLogger, metrics },
    { initialRetryMs: 100, maxRetryMs: 400 },
  );
  return { fake, pubsub, c };
}

afterEach(() => vi.useRealTimers());

describe('JudgedConsumer', () => {
  it('se suscribe sin fromBeginning y con commit manual', async () => {
    const { fake, c } = setup();
    await c.start();
    expect(c.isRunning()).toBe(true);
    expect(fake.consumer.subscribe).toHaveBeenCalledWith({
      topic: 'submission.judged',
      fromBeginning: false,
    });
    expect(fake.consumer.run).toHaveBeenCalledWith(expect.objectContaining({ autoCommit: false }));
  });

  it('publica en el canal de la submission y, con contest, en el del scoreboard; luego commitea', async () => {
    const { fake, pubsub, c } = setup();
    await c.start();
    const subEvents = pubsub.subscribe(submissionChannel('s1'));
    const boardEvents = pubsub.subscribe(scoreboardChannel('c1'));
    await fake.deliver(judged({ contestId: 'c1' }));
    const ev = (await subEvents.next()).value as JudgedEvent;
    expect(ev).toEqual({
      eventId: 'e1',
      submissionId: 's1',
      userId: 'u1',
      problemId: 'p1',
      contestId: 'c1',
      verdict: 'WRONG_ANSWER',
      timeMs: 10,
      memoryKb: 2048,
      passedCases: 1,
      totalCases: 3,
      submittedAt: null,
      judgedAt: '2025-11-22T14:00:00.005Z',
    });
    expect((await boardEvents.next()).value).toEqual(ev);
    expect(fake.consumer.commitOffsets).toHaveBeenCalledWith([
      { topic: 'submission.judged', partition: 1, offset: '8' },
    ]);
  });

  it('sin contest no publica en el scoreboard', async () => {
    const { fake, pubsub, c } = setup();
    await c.start();
    const published = vi.spyOn(pubsub, 'publish');
    await fake.deliver(judged());
    expect(published).toHaveBeenCalledTimes(1);
    expect(published.mock.calls[0]![0]).toBe(submissionChannel('s1'));
  });

  it('descarta duplicados por event_id (pero commitea)', async () => {
    const { fake, pubsub, c } = setup();
    await c.start();
    const published = vi.spyOn(pubsub, 'publish');
    await fake.deliver(judged(), '1');
    await fake.deliver(judged(), '2');
    expect(published).toHaveBeenCalledTimes(1);
    expect(fake.consumer.commitOffsets).toHaveBeenCalledTimes(2);
  });

  it('mensajes inválidos se saltan sin publicar ni frenar el consumidor', async () => {
    const { fake, pubsub, c } = setup();
    await c.start();
    const published = vi.spyOn(pubsub, 'publish');
    await fake.deliver(Buffer.from([0xff, 0xff, 0xff]));
    await fake.deliver(null);
    // Protobuf válido pero sin event_id.
    const noEventId = toBinary(
      SubmissionJudgedSchema,
      create(SubmissionJudgedSchema, { submissionId: 's1', verdict: Verdict.ACCEPTED }),
    );
    await fake.deliver(Buffer.from(noEventId));
    expect(published).not.toHaveBeenCalled();
    expect(fake.consumer.commitOffsets).toHaveBeenCalledTimes(3);
  });

  it('readiness sigue los eventos de kafkajs', async () => {
    const { fake, c } = setup();
    await c.start();
    expect(c.readiness.status().ready).toBe(false);
    fake.emit(EVENTS.GROUP_JOIN);
    expect(c.readiness.status()).toEqual({ joined: true, crashed: false, ready: true });
    fake.emit(EVENTS.CRASH, { restart: true, error: new Error('x') });
    expect(c.readiness.status().ready).toBe(false);
    fake.emit(EVENTS.GROUP_JOIN);
    fake.emit(EVENTS.DISCONNECT);
    expect(c.readiness.status().joined).toBe(false);
  });

  it('Kafka caído al arrancar: reintenta con backoff hasta conectar', async () => {
    vi.useFakeTimers();
    const { fake, c } = setup();
    fake.consumer.connect
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await c.start();
    expect(c.isRunning()).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(c.isRunning()).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(c.isRunning()).toBe(true);
    expect(fake.consumer.connect).toHaveBeenCalledTimes(3);
  });

  it('crash sin reinicio automático: se rearranca solo', async () => {
    vi.useFakeTimers();
    const { fake, c } = setup();
    await c.start();
    fake.emit(EVENTS.CRASH, { restart: false, error: new Error('fatal') });
    expect(c.isRunning()).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(c.isRunning()).toBe(true);
    expect(fake.consumer.connect).toHaveBeenCalledTimes(2);
  });

  it('stop detiene los reintentos y desconecta', async () => {
    vi.useFakeTimers();
    const { fake, c } = setup();
    fake.consumer.connect.mockRejectedValue(new Error('down'));
    await c.start();
    await c.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.consumer.connect).toHaveBeenCalledTimes(1);
    expect(fake.consumer.disconnect).toHaveBeenCalled();
  });
});
