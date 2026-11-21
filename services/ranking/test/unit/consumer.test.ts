import { EventEmitter } from 'node:events';
import { encodeEvent, Topics } from '@juez/contracts';
import { Verdict } from '@juez/contracts/es';
import type { Consumer, EachMessagePayload, Producer } from 'kafkajs';
import { describe, expect, it, vi } from 'vitest';
import {
  EventProcessor,
  InvalidEventError,
  parseSubmissionJudged,
  parseUserRegistered,
} from '../../src/events/processor.js';
import { isPermanentDbError, RankingConsumer } from '../../src/kafka/consumer.js';
import { kafkaLogCreator } from '../../src/kafka/kafka.js';
import { createMetrics } from '../../src/metrics.js';
import { ScoreboardProjector } from '../../src/projection/projector.js';
import { ScoreboardStore } from '../../src/projection/scoreboard-store.js';
import {
  FakeRedis,
  InMemoryRankingRepository,
  judgedEvent,
  makeContest,
  memoryLogger,
  minutes,
  registeredEvent,
  silentLogger,
  uuid,
} from '../helpers.js';

const EVENTS = {
  GROUP_JOIN: 'consumer.group_join',
  CRASH: 'consumer.crash',
  STOP: 'consumer.stop',
  DISCONNECT: 'consumer.disconnect',
};

class FakeConsumer extends EventEmitter {
  events = EVENTS;
  connectFailures = 0;
  connect = vi.fn(async () => {
    if (this.connectFailures-- > 0) throw new Error('kafka no disponible');
  });
  subscribe = vi.fn(async () => {});
  run = vi.fn(async () => {
    this.emit(EVENTS.GROUP_JOIN, { payload: {} });
  });
  disconnect = vi.fn(async () => {
    this.emit(EVENTS.DISCONNECT, { payload: {} });
  });
  commitOffsets = vi.fn(async () => {});
  override on(event: string, listener: (...args: unknown[]) => void) {
    return super.on(event, listener);
  }
}

class FakeProducer {
  connect = vi.fn(async () => {});
  disconnect = vi.fn(async () => {});
  send = vi.fn(async () => []);
}

function setup(opts: { processingAttempts?: number } = {}) {
  const repo = new InMemoryRankingRepository();
  const contest = repo.addContest(makeContest());
  const store = new ScoreboardStore(new FakeRedis());
  const projector = new ScoreboardProjector(repo, store, silentLogger);
  const processor = new EventProcessor({ repo, projector, logger: silentLogger });
  const consumer = new FakeConsumer();
  const producer = new FakeProducer();
  const metrics = createMetrics({ defaultMetrics: false });
  const rc = new RankingConsumer(
    {
      consumer: consumer as unknown as Consumer,
      producer: producer as unknown as Producer,
      processor,
      logger: silentLogger,
      metrics,
    },
    {
      initialRetryMs: 5,
      maxRetryMs: 20,
      processingAttempts: opts.processingAttempts ?? 3,
      processingRetryMs: 1,
    },
  );
  return { repo, contest, store, projector, consumer, producer, rc, metrics };
}

function payload(topic: string, value: Buffer | null, offset = '41'): EachMessagePayload {
  return {
    topic,
    partition: 2,
    message: {
      key: Buffer.from('k'),
      value,
      offset,
      timestamp: '0',
      attributes: 0,
      size: 0,
      headers: { 'event-type': 'x' },
    },
    heartbeat: vi.fn(async () => {}),
    pause: vi.fn(() => () => {}),
  } as unknown as EachMessagePayload;
}

const encodedJudged = (init: Parameters<typeof judgedEvent>[0]) =>
  encodeEvent(Topics.SUBMISSION_JUDGED, judgedEvent(init)).value;

describe('validación de eventos', () => {
  it('rechaza user.registered con datos inválidos', () => {
    expect(() => parseUserRegistered(registeredEvent('x', 'a'))).toThrow(InvalidEventError);
    expect(() => parseUserRegistered(registeredEvent(uuid(1), '  '))).toThrow(/username/);
    expect(() => parseUserRegistered(registeredEvent(uuid(1), 'a', ''))).toThrow(/event_id/);
    expect(parseUserRegistered(registeredEvent(uuid(1), ' ana '))).toMatchObject({
      username: 'ana',
    });
  });

  it('rechaza submission.judged sin veredicto final, sin submitted_at o con ids inválidos', () => {
    const now = minutes(0);
    const ok = { submittedAt: minutes(1) };
    expect(() =>
      parseSubmissionJudged(judgedEvent({ ...ok, verdict: Verdict.PENDING }), now),
    ).toThrow(/veredicto/);
    expect(() => parseSubmissionJudged(judgedEvent({}), now)).toThrow(/submitted_at/);
    expect(() => parseSubmissionJudged(judgedEvent({ ...ok, userId: 'u' }), now)).toThrow(
      /user_id/,
    );
    expect(() => parseSubmissionJudged(judgedEvent({ ...ok, contestId: 'c' }), now)).toThrow(
      /contest_id/,
    );
    const parsed = parseSubmissionJudged(
      judgedEvent({ ...ok, verdict: Verdict.COMPILATION_ERROR }),
      now,
    );
    expect(parsed).toMatchObject({ verdict: 'COMPILATION_ERROR', contestId: null });
  });
});

describe('RankingConsumer.handleMessage', () => {
  it('aplica el evento y hace commit del offset siguiente después de procesar', async () => {
    const { rc, consumer, repo, contest, store } = setup();
    const value = encodedJudged({ contestId: contest.id, submittedAt: minutes(3) });
    await rc.handleMessage(payload(Topics.SUBMISSION_JUDGED, value));
    expect(repo.submissions.size).toBe(1);
    expect(consumer.commitOffsets).toHaveBeenCalledWith([
      { topic: Topics.SUBMISSION_JUDGED, partition: 2, offset: '42' },
    ]);
    expect((await store.readPage(contest.id, 0, 10)).rows).toHaveLength(1);
  });

  it('procesa user.registered', async () => {
    const { rc, repo } = setup();
    const value = encodeEvent(Topics.USER_REGISTERED, registeredEvent(uuid(5), 'eve')).value;
    await rc.handleMessage(payload(Topics.USER_REGISTERED, value));
    expect(repo.names.get(uuid(5))).toBe('eve');
  });

  it('envía a la DLQ los mensajes que no se pueden deserializar y hace commit', async () => {
    const { rc, consumer, producer } = setup();
    await rc.handleMessage(payload(Topics.SUBMISSION_JUDGED, Buffer.from([0xff, 0xff, 0xff])));
    await rc.handleMessage(payload(Topics.USER_REGISTERED, null));
    expect(producer.send).toHaveBeenCalledTimes(2);
    expect(producer.send).toHaveBeenCalledWith({
      topic: 'submission.judged.dlq',
      messages: [
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-dlq-reason': 'deserialization_error',
            'x-original-topic': Topics.SUBMISSION_JUDGED,
            'x-original-partition': '2',
            'x-original-offset': '41',
            'event-type': 'x',
          }),
        }),
      ],
    });
    expect(consumer.commitOffsets).toHaveBeenCalledTimes(2);
  });

  it('envía a la DLQ los eventos con datos inválidos', async () => {
    const { rc, producer, consumer } = setup();
    const value = encodedJudged({ verdict: Verdict.JUDGING, submittedAt: minutes(1) });
    await rc.handleMessage(payload(Topics.SUBMISSION_JUDGED, value));
    expect(producer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: 'submission.judged.dlq',
        messages: [
          expect.objectContaining({
            headers: expect.objectContaining({ 'x-dlq-reason': 'invalid_event' }),
          }),
        ],
      }),
    );
    expect(consumer.commitOffsets).toHaveBeenCalledOnce();
  });

  it('error transitorio de la BD: reintenta y, si persiste, relanza sin commit', async () => {
    const { rc, repo, consumer, producer } = setup({ processingAttempts: 3 });
    repo.applyFailures = [new Error('conexión'), new Error('conexión'), new Error('conexión')];
    const p = payload(Topics.SUBMISSION_JUDGED, encodedJudged({ submittedAt: minutes(1) }));
    await expect(rc.handleMessage(p)).rejects.toThrow('conexión');
    expect(consumer.commitOffsets).not.toHaveBeenCalled();
    expect(producer.send).not.toHaveBeenCalled();
    expect(p.heartbeat).toHaveBeenCalledTimes(2);
  });

  it('error transitorio que se recupera dentro de los reintentos: commit normal', async () => {
    const { rc, repo, consumer } = setup();
    repo.applyFailures = [new Error('conexión')];
    await rc.handleMessage(
      payload(Topics.SUBMISSION_JUDGED, encodedJudged({ submittedAt: minutes(1) })),
    );
    expect(repo.submissions.size).toBe(1);
    expect(consumer.commitOffsets).toHaveBeenCalledOnce();
  });

  it('error permanente de datos: tras N intentos va a la DLQ', async () => {
    const { rc, repo, producer, consumer } = setup({ processingAttempts: 2 });
    const pgError = Object.assign(new Error('value too long'), { code: '22001' });
    repo.applyFailures = [pgError, new Error('wrapped', { cause: pgError })];
    await rc.handleMessage(
      payload(Topics.SUBMISSION_JUDGED, encodedJudged({ submittedAt: minutes(1) })),
    );
    expect(producer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            headers: expect.objectContaining({ 'x-dlq-reason': 'processing_error' }),
          }),
        ],
      }),
    );
    expect(consumer.commitOffsets).toHaveBeenCalledOnce();
  });

  it('ignora (con commit) topics inesperados', async () => {
    const { rc, consumer } = setup();
    await rc.handleMessage(payload('otro.topic', Buffer.from('x')));
    expect(consumer.commitOffsets).toHaveBeenCalledOnce();
  });

  it('clasifica errores permanentes de Postgres', () => {
    expect(isPermanentDbError(Object.assign(new Error(), { code: '22P02' }))).toBe(true);
    expect(isPermanentDbError(Object.assign(new Error(), { code: '23505' }))).toBe(true);
    expect(isPermanentDbError(Object.assign(new Error(), { code: '08006' }))).toBe(false);
    expect(isPermanentDbError(Object.assign(new Error(), { code: 'ECONNREFUSED' }))).toBe(false);
    expect(isPermanentDbError(undefined)).toBe(false);
  });
});

describe('RankingConsumer arranque y readiness', () => {
  it('suscribe ambos topics con fromBeginning y commit manual', async () => {
    const { rc, consumer } = setup();
    await rc.start();
    expect(consumer.subscribe).toHaveBeenCalledWith({
      topics: [Topics.USER_REGISTERED, Topics.SUBMISSION_JUDGED],
      fromBeginning: true,
    });
    expect(consumer.run).toHaveBeenCalledWith(expect.objectContaining({ autoCommit: false }));
    expect(rc.isRunning()).toBe(true);
    expect(rc.readiness.ready).toBe(true);
    await rc.stop();
    expect(rc.readiness.ready).toBe(false);
  });

  it('si Kafka no está disponible arranca igual y reintenta con backoff hasta conectar', async () => {
    const { rc, consumer } = setup();
    consumer.connectFailures = 2;
    await rc.start();
    expect(rc.isRunning()).toBe(false);
    expect(rc.readiness.ready).toBe(false);
    await vi.waitFor(() => expect(rc.isRunning()).toBe(true), { timeout: 2_000 });
    expect(consumer.connect).toHaveBeenCalledTimes(3);
    expect(rc.readiness.ready).toBe(true);
    await rc.stop();
  });

  it('CRASH marca no-ready; sin reinicio automático vuelve a arrancar', async () => {
    const { rc, consumer } = setup();
    await rc.start();
    consumer.emit(EVENTS.CRASH, { payload: { error: new Error('x'), restart: true } });
    expect(rc.readiness.ready).toBe(false);
    consumer.emit(EVENTS.GROUP_JOIN, { payload: {} });
    expect(rc.readiness.ready).toBe(true);
    consumer.emit(EVENTS.CRASH, { payload: { error: new Error('fatal'), restart: false } });
    await vi.waitFor(() => expect(consumer.connect).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    await vi.waitFor(() => expect(rc.readiness.ready).toBe(true));
    await rc.stop();
  });

  it('stop() cancela los reintentos pendientes', async () => {
    const { rc, consumer } = setup();
    consumer.connectFailures = 100;
    await rc.start();
    await rc.stop();
    await new Promise((r) => setTimeout(r, 30));
    expect(consumer.connect).toHaveBeenCalledTimes(1);
  });
});

describe('kafkaLogCreator', () => {
  it('traduce los niveles de kafkajs a pino', () => {
    const { logger, lines } = memoryLogger();
    const log = kafkaLogCreator(logger)();
    for (const level of [1, 2, 4, 5]) {
      log({ namespace: 'x', level, label: '', log: { message: `m${level}`, timestamp: '' } });
    }
    expect(lines().map((l) => l.level)).toEqual(['error', 'warn', 'info', 'debug']);
  });
});
