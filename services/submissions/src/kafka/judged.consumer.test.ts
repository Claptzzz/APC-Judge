import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backoffDelay } from '../backoff.js';
import { JudgedConsumer } from './judged.consumer.js';
import type { JudgedConsumerOptions } from './judged.consumer.js';
import { createLogger } from '../logger.js';
import { createMetrics } from '../metrics.js';
import type { SubmissionsRepository } from '../repository.js';
import { encodeEvent, Topics } from '@juez/contracts';
import { Verdict } from '@juez/contracts/es';
import type { Consumer, KafkaMessage, Producer } from 'kafkajs';

const EVENTS = {
  GROUP_JOIN: 'consumer.group_join',
  CRASH: 'consumer.crash',
  STOP: 'consumer.stop',
  DISCONNECT: 'consumer.disconnect',
} as const;

/** Consumer falso de kafkajs con eventos instrumentados reales (EventEmitter). */
function fakeConsumer() {
  const emitter = new EventEmitter();
  const consumer = {
    events: EVENTS,
    on: (event: string, listener: (e: unknown) => void) => {
      emitter.on(event, listener);
      return () => emitter.off(event, listener);
    },
    connect: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(undefined),
    run: vi.fn().mockResolvedValue(undefined),
    commitOffsets: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
  const emit = (event: string, payload: Record<string, unknown> = {}) =>
    emitter.emit(event, { id: 0, type: event, timestamp: Date.now(), payload });
  return { consumer, emit };
}

function fakeProducer() {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue([]),
  };
}

const logger = createLogger('silent');
const metrics = createMetrics({ defaultMetrics: false });

function build(
  opts: {
    repo?: Partial<SubmissionsRepository>;
    options?: JudgedConsumerOptions;
  } = {},
) {
  const { consumer, emit } = fakeConsumer();
  const producer = fakeProducer();
  const repo = { updateVerdict: vi.fn().mockResolvedValue(true), ...opts.repo };
  const judged = new JudgedConsumer(
    {
      consumer: consumer as unknown as Consumer,
      producer: producer as unknown as Producer,
      repo: repo as unknown as SubmissionsRepository,
      logger,
      metrics,
    },
    opts.options,
  );
  return { judged, consumer, producer, repo, emit };
}

function judgedMessage(verdict: Verdict = Verdict.ACCEPTED) {
  const event = encodeEvent(Topics.SUBMISSION_JUDGED, {
    submissionId: '550e8400-e29b-41d4-a716-446655440000',
    userId: '660e8400-e29b-41d4-a716-446655440000',
    problemId: '770e8400-e29b-41d4-a716-446655440000',
    verdict,
    timeMs: 42,
    memoryKb: 1024,
    passedCases: 10,
    totalCases: 10,
  });
  return {
    offset: '10',
    key: Buffer.from(event.key),
    value: event.value,
    headers: event.headers,
  } as unknown as KafkaMessage;
}

function invoke(judged: JudgedConsumer, message: KafkaMessage) {
  // @ts-expect-error test invoke de método privado
  return judged.handleMessage({ topic: Topics.SUBMISSION_JUDGED, partition: 0, message });
}

describe('backoffDelay', () => {
  it('duplica la espera en cada intento y la topa en el máximo', () => {
    expect(backoffDelay(0, 1000, 30_000)).toBe(1000);
    expect(backoffDelay(1, 1000, 30_000)).toBe(2000);
    expect(backoffDelay(4, 1000, 30_000)).toBe(16_000);
    expect(backoffDelay(5, 1000, 30_000)).toBe(30_000);
    expect(backoffDelay(20, 1000, 30_000)).toBe(30_000);
  });
});

describe('JudgedConsumer — arranque', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('arranca: connect, subscribe y run con commit manual', async () => {
    const { judged, consumer, producer } = build();
    await judged.start();

    expect(judged.isRunning()).toBe(true);
    expect(consumer.connect).toHaveBeenCalledTimes(1);
    expect(producer.connect).toHaveBeenCalledTimes(1);
    expect(consumer.subscribe).toHaveBeenCalledWith({
      topic: Topics.SUBMISSION_JUDGED,
      fromBeginning: false,
    });
    expect(consumer.run).toHaveBeenCalledWith(expect.objectContaining({ autoCommit: false }));

    // Llamar start() de nuevo no reconecta
    await judged.start();
    expect(consumer.connect).toHaveBeenCalledTimes(1);
  });

  it('si start() falla no lanza, queda running=false y reintenta con backoff exponencial', async () => {
    const { judged, consumer } = build({ options: { initialRetryMs: 1000, maxRetryMs: 30_000 } });
    consumer.connect
      .mockRejectedValueOnce(new Error('broker caído'))
      .mockRejectedValueOnce(new Error('broker caído'))
      .mockResolvedValue(undefined);

    await expect(judged.start()).resolves.toBeUndefined();
    expect(judged.isRunning()).toBe(false);
    expect(consumer.connect).toHaveBeenCalledTimes(1);
    // limpia el estado parcial antes de reintentar
    expect(consumer.disconnect).toHaveBeenCalled();

    // 1er reintento a los 1000 ms (falla otra vez)
    await vi.advanceTimersByTimeAsync(999);
    expect(consumer.connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(consumer.connect).toHaveBeenCalledTimes(2);
    expect(judged.isRunning()).toBe(false);

    // 2º reintento a los 2000 ms más (conecta)
    await vi.advanceTimersByTimeAsync(1999);
    expect(consumer.connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(consumer.connect).toHaveBeenCalledTimes(3);
    expect(judged.isRunning()).toBe(true);

    // Ya corriendo: no hay más reintentos
    await vi.advanceTimersByTimeAsync(60_000);
    expect(consumer.connect).toHaveBeenCalledTimes(3);
  });

  it('el backoff no supera el tope de 30 s por defecto', async () => {
    const { judged, consumer } = build();
    consumer.connect.mockRejectedValue(new Error('broker caído'));

    await judged.start();
    // 1 + 2 + 4 + 8 + 16 s = 31 s → 6 intentos
    await vi.advanceTimersByTimeAsync(31_000);
    expect(consumer.connect).toHaveBeenCalledTimes(6);
    // siguiente espera: 30 s (tope), no 32 s
    await vi.advanceTimersByTimeAsync(29_999);
    expect(consumer.connect).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(1);
    expect(consumer.connect).toHaveBeenCalledTimes(7);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(consumer.connect).toHaveBeenCalledTimes(8);

    await judged.stop();
  });

  it('un fallo en subscribe o run también reintenta', async () => {
    const { judged, consumer } = build({ options: { initialRetryMs: 10 } });
    consumer.run.mockRejectedValueOnce(new Error('run falló'));

    await judged.start();
    expect(judged.isRunning()).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    expect(consumer.run).toHaveBeenCalledTimes(2);
    expect(judged.isRunning()).toBe(true);
  });

  it('stop() cancela los reintentos pendientes', async () => {
    const { judged, consumer } = build({ options: { initialRetryMs: 1000 } });
    consumer.connect.mockRejectedValue(new Error('broker caído'));

    await judged.start();
    await judged.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(consumer.connect).toHaveBeenCalledTimes(1);
    expect(judged.isRunning()).toBe(false);
  });

  it('stop() durante un arranque en curso desconecta al terminar', async () => {
    const { judged, consumer } = build();
    let release!: () => void;
    consumer.connect.mockReturnValueOnce(new Promise<void>((r) => (release = r)));

    const starting = judged.start();
    await judged.stop();
    release();
    await starting;

    expect(judged.isRunning()).toBe(false);
    expect(consumer.disconnect).toHaveBeenCalled();
  });

  it('stop() desconecta un consumidor en marcha', async () => {
    const { judged, consumer, producer } = build();
    await judged.start();
    await judged.stop();
    expect(judged.isRunning()).toBe(false);
    expect(consumer.disconnect).toHaveBeenCalledTimes(1);
    expect(producer.disconnect).toHaveBeenCalledTimes(1);
  });

  it('tras un CRASH sin reinicio de kafkajs vuelve a arrancar con backoff', async () => {
    const { judged, consumer, emit } = build({ options: { initialRetryMs: 500 } });
    await judged.start();
    expect(consumer.connect).toHaveBeenCalledTimes(1);

    emit(EVENTS.CRASH, { error: new Error('no reintentable'), restart: false });
    expect(judged.isRunning()).toBe(false);

    await vi.advanceTimersByTimeAsync(500);
    expect(consumer.connect).toHaveBeenCalledTimes(2);
    expect(judged.isRunning()).toBe(true);
  });

  it('tras un CRASH con reinicio de kafkajs no interviene', async () => {
    const { judged, consumer, emit } = build({ options: { initialRetryMs: 500 } });
    await judged.start();

    emit(EVENTS.CRASH, { error: new Error('reintentable'), restart: true });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(consumer.connect).toHaveBeenCalledTimes(1);
    expect(judged.isRunning()).toBe(true);
  });
});

describe('JudgedConsumer — readiness', () => {
  it('no está listo hasta unirse al grupo', async () => {
    const { judged, emit } = build();
    expect(judged.readiness.status()).toEqual({ joined: false, crashed: false, ready: false });

    await judged.start();
    // running pero todavía sin GROUP_JOIN
    expect(judged.readiness.status().ready).toBe(false);

    emit(EVENTS.GROUP_JOIN);
    expect(judged.readiness.status()).toEqual({ joined: true, crashed: false, ready: true });
    await judged.stop();
  });

  it('CRASH lo marca no listo hasta el siguiente GROUP_JOIN', async () => {
    const { judged, emit } = build();
    emit(EVENTS.GROUP_JOIN);
    emit(EVENTS.CRASH, { error: new Error('x'), restart: true });
    expect(judged.readiness.status()).toEqual({ joined: true, crashed: true, ready: false });

    emit(EVENTS.GROUP_JOIN);
    expect(judged.readiness.status().ready).toBe(true);
  });

  it.each([EVENTS.STOP, EVENTS.DISCONNECT])('%s lo marca no listo', (event) => {
    const { judged, emit } = build();
    emit(EVENTS.GROUP_JOIN);
    emit(event);
    expect(judged.readiness.status()).toEqual({ joined: false, crashed: false, ready: false });
  });
});

describe('JudgedConsumer — mensajes', () => {
  it('procesa evento submission.judged, actualiza repositorio y commitea', async () => {
    const { judged, consumer, repo } = build();
    await invoke(judged, judgedMessage());

    expect(repo.updateVerdict).toHaveBeenCalledWith(
      expect.objectContaining({
        submissionId: '550e8400-e29b-41d4-a716-446655440000',
        verdict: 'ACCEPTED',
        timeMs: 42,
        memoryKb: 1024,
        passedCases: 10,
        totalCases: 10,
      }),
    );
    expect(consumer.commitOffsets).toHaveBeenCalledWith([
      { topic: Topics.SUBMISSION_JUDGED, partition: 0, offset: '11' },
    ]);
  });

  it('descarta duplicados pero commitea el offset', async () => {
    const { judged, consumer } = build({
      repo: { updateVerdict: vi.fn().mockResolvedValue(false) },
    });
    await invoke(judged, judgedMessage());
    expect(consumer.commitOffsets).toHaveBeenCalledTimes(1);
  });

  it('envía mensaje corrupto a DLQ y commitea offset', async () => {
    const { judged, consumer, producer, repo } = build();
    await invoke(judged, {
      offset: '5',
      key: Buffer.from('sub-1'),
      value: Buffer.from('corrupted-data'),
      headers: {},
    } as unknown as KafkaMessage);

    expect(repo.updateVerdict).not.toHaveBeenCalled();
    expect(producer.send).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'submission.judged.dlq' }),
    );
    expect(consumer.commitOffsets).toHaveBeenCalledWith([
      { topic: Topics.SUBMISSION_JUDGED, partition: 0, offset: '6' },
    ]);
  });

  it('envía veredicto desconocido a DLQ', async () => {
    const { judged, producer, repo } = build();
    await invoke(judged, judgedMessage(999 as Verdict));
    expect(repo.updateVerdict).not.toHaveBeenCalled();
    const sent = producer.send.mock.calls[0]?.[0] as {
      messages: { headers: Record<string, string> }[];
    };
    expect(sent.messages[0]?.headers['x-dlq-reason']).toBe('unknown_verdict');
  });

  it('si la BD falla relanza el error sin commitear (kafkajs reintenta)', async () => {
    const { judged, consumer } = build({
      repo: { updateVerdict: vi.fn().mockRejectedValue(new Error('db down')) },
    });
    await expect(invoke(judged, judgedMessage())).rejects.toThrow('db down');
    expect(consumer.commitOffsets).not.toHaveBeenCalled();
  });
});
