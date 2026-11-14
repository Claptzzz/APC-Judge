import { DlqTopics, Topics, decodeEvent, encodeEvent } from '@juez/contracts';
import { Language, Verdict } from '@juez/contracts/es';
import type { EachMessagePayload, KafkaMessage } from 'kafkajs';
import { describe, expect, it, vi } from 'vitest';
import { judgedEventId } from './event-id.js';
import type { JudgeOutcome } from './judge.js';
import { Metrics } from './metrics.js';
import { buildJudgedMessage, createMessageHandler } from './worker.js';
import type { JudgeFn } from './worker.js';
import { makeSubmission, silentLogger } from './test-utils/index.js';

const SUBMISSION_ID = '22222222-2222-4222-8222-222222222222';
const ACCEPTED: JudgeOutcome = {
  verdict: Verdict.ACCEPTED,
  timeMs: 12,
  memoryKb: 3456,
  passedCases: 3,
  totalCases: 3,
};

function validMessage(headers: KafkaMessage['headers'] = {}): KafkaMessage {
  const encoded = encodeEvent(Topics.SUBMISSION_CREATED, {
    submissionId: SUBMISSION_ID,
    userId: 'u-1',
    problemId: 'p-1',
    contestId: 'c-1',
    language: Language.PYTHON3,
    sourceCode: 'print(1)',
    occurredAt: { seconds: 1_700_000_000n, nanos: 0 },
  });
  return {
    key: Buffer.from(encoded.key),
    value: encoded.value,
    headers: { ...encoded.headers, ...headers },
    offset: '41',
    timestamp: '0',
    attributes: 0,
  };
}

function setup(judge: JudgeFn = async () => ACCEPTED) {
  const calls: string[] = [];
  const producer = {
    send: vi.fn(async (record: { topic: string }) => {
      calls.push(`send:${record.topic}`);
      return [];
    }),
  };
  const consumer = {
    commitOffsets: vi.fn(async () => {
      calls.push('commit');
    }),
  };
  const metrics = new Metrics();
  const handler = createMessageHandler({
    consumer,
    producer,
    judge: vi.fn(judge),
    logger: silentLogger,
    metrics,
    heartbeatIntervalMs: 5,
  });
  const run = (message: KafkaMessage, heartbeat = vi.fn(async () => {})) =>
    handler({
      topic: Topics.SUBMISSION_CREATED,
      partition: 2,
      message,
      heartbeat,
      pause: () => () => {},
    } as EachMessagePayload);
  return { producer, consumer, metrics, run, calls };
}

describe('createMessageHandler', () => {
  it('publica submission.judged y luego hace commit del offset siguiente', async () => {
    const { producer, consumer, run, calls, metrics } = setup();
    await run(validMessage({ 'x-request-id': 'req-9' }));

    expect(calls).toEqual([`send:${Topics.SUBMISSION_JUDGED}`, 'commit']);
    expect(consumer.commitOffsets).toHaveBeenCalledWith([
      { topic: Topics.SUBMISSION_CREATED, partition: 2, offset: '42' },
    ]);

    const sent = producer.send.mock.calls[0]![0] as unknown as {
      messages: { key: string; value: Buffer; headers: Record<string, string> }[];
    };
    const message = sent.messages[0]!;
    expect(message.key).toBe(SUBMISSION_ID);
    expect(message.headers['x-request-id']).toBe('req-9');
    expect(message.headers['event-id']).toBe(judgedEventId(SUBMISSION_ID));

    const judged = decodeEvent(Topics.SUBMISSION_JUDGED, message.value);
    expect(judged).toMatchObject({
      eventId: judgedEventId(SUBMISSION_ID),
      submissionId: SUBMISSION_ID,
      userId: 'u-1',
      problemId: 'p-1',
      contestId: 'c-1',
      verdict: Verdict.ACCEPTED,
      timeMs: 12,
      memoryKb: 3456,
      passedCases: 3,
      totalCases: 3,
    });
    expect(judged.submittedAt?.seconds).toBe(1_700_000_000n);
    expect(metrics.render()).toContain('judge_submissions_judged_total{verdict="ACCEPTED"} 1');
  });

  it('un reproceso genera el mismo event_id', async () => {
    const first = setup();
    const second = setup(async () => ({ ...ACCEPTED, verdict: Verdict.WRONG_ANSWER }));
    await first.run(validMessage());
    await second.run(validMessage());
    const idOf = (p: typeof first.producer) =>
      (p.send.mock.calls[0]![0] as unknown as { messages: { headers: Record<string, string> }[] })
        .messages[0]!.headers['event-id'];
    expect(idOf(first.producer)).toBe(idOf(second.producer));
  });

  it('envía a la DLQ y hace commit si el mensaje no se puede deserializar', async () => {
    const { producer, consumer, run, calls, metrics } = setup();
    const garbage: KafkaMessage = { ...validMessage(), value: Buffer.from([0xff, 0xff, 0xff]) };
    await run(garbage);

    expect(calls).toEqual([`send:${DlqTopics.SUBMISSION_CREATED}`, 'commit']);
    const record = producer.send.mock.calls[0]![0] as unknown as {
      messages: { value: Buffer; headers: Record<string, string> }[];
    };
    expect(record.messages[0]!.value).toEqual(garbage.value);
    expect(record.messages[0]!.headers).toMatchObject({
      'x-dlq-reason': 'deserialization',
      'x-original-topic': Topics.SUBMISSION_CREATED,
      'x-original-partition': '2',
      'x-original-offset': '41',
    });
    expect(consumer.commitOffsets).toHaveBeenCalledWith([
      { topic: Topics.SUBMISSION_CREATED, partition: 2, offset: '42' },
    ]);
    expect(metrics.render()).toContain('judge_dlq_messages_total 1');
  });

  it('envía a la DLQ un mensaje vacío o sin submission_id', async () => {
    const empty = setup();
    await empty.run({ ...validMessage(), value: null });
    expect(empty.calls).toEqual([`send:${DlqTopics.SUBMISSION_CREATED}`, 'commit']);

    const noId = setup();
    // Protobuf válido con solo user_id = "a" (campo 4): submission_id queda vacío.
    await noId.run({ ...validMessage(), value: Buffer.from([0x22, 0x01, 0x61]) });
    expect(noId.calls).toEqual([`send:${DlqTopics.SUBMISSION_CREATED}`, 'commit']);
  });

  it('no hace commit si falla la publicación (kafkajs reintenta el mensaje)', async () => {
    const { producer, consumer, run } = setup();
    producer.send.mockRejectedValueOnce(new Error('broker caído'));
    await expect(run(validMessage())).rejects.toThrow('broker caído');
    expect(consumer.commitOffsets).not.toHaveBeenCalled();
  });

  it('publica INTERNAL_ERROR si el juez lanza un error inesperado', async () => {
    const { producer, run } = setup(async () => {
      throw new Error('bug');
    });
    await run(validMessage());
    const record = producer.send.mock.calls[0]![0] as unknown as { messages: { value: Buffer }[] };
    expect(decodeEvent(Topics.SUBMISSION_JUDGED, record.messages[0]!.value).verdict).toBe(
      Verdict.INTERNAL_ERROR,
    );
  });

  it('envía heartbeats mientras evalúa una submission larga', async () => {
    const { run } = setup(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return ACCEPTED;
    });
    const heartbeat = vi.fn(async () => {
      throw new Error('rebalanceo');
    });
    await run(validMessage(), heartbeat);
    expect(heartbeat.mock.calls.length).toBeGreaterThan(0);
  });
});

describe('buildJudgedMessage', () => {
  it('omite contest_id si la submission no es de un contest', () => {
    const judged = buildJudgedMessage(makeSubmission({ contestId: undefined }), ACCEPTED);
    expect(judged.key).toBe('22222222-2222-4222-8222-222222222222');
    expect(judged.event.contestId).toBeUndefined();
  });
});
