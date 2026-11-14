import { randomUUID } from 'node:crypto';
import { DlqTopics, Topics, decodeEvent, encodeEvent } from '@juez/contracts';
import { Verdict } from '@juez/contracts/es';
import type { SubmissionCreated } from '@juez/contracts/es';
import type { Consumer, EachMessagePayload, IHeaders, Producer } from 'kafkajs';
import { judgedEventId } from './event-id.js';
import type { JudgeContext, JudgeOutcome } from './judge.js';
import type { Logger } from './logger.js';
import type { Metrics } from './metrics.js';
import { REQUEST_ID_HEADER } from './problems-client.js';

export type JudgeFn = (submission: SubmissionCreated, ctx: JudgeContext) => Promise<JudgeOutcome>;

export interface WorkerDeps {
  consumer: Pick<Consumer, 'commitOffsets'>;
  producer: Pick<Producer, 'send'>;
  judge: JudgeFn;
  logger: Logger;
  metrics?: Metrics;
  /** Intervalo de heartbeat al grupo mientras se evalúa una submission larga. */
  heartbeatIntervalMs?: number;
}

function headerString(headers: IHeaders | undefined, name: string): string | undefined {
  const value = headers?.[name];
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined ? undefined : first.toString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Construye el `SubmissionJudged` (con `event_id` determinista) listo para kafkajs. */
export function buildJudgedMessage(submission: SubmissionCreated, result: JudgeOutcome) {
  return encodeEvent(Topics.SUBMISSION_JUDGED, {
    eventId: judgedEventId(submission.submissionId),
    submissionId: submission.submissionId,
    userId: submission.userId,
    problemId: submission.problemId,
    contestId: submission.contestId,
    verdict: result.verdict,
    timeMs: result.timeMs,
    memoryKb: result.memoryKb,
    passedCases: result.passedCases,
    totalCases: result.totalCases,
    // occurred_at de submission.created = momento de creación de la submission.
    submittedAt: submission.occurredAt,
  });
}

/**
 * Handler de `eachMessage` para `submission.created`. Procesa un mensaje, publica
 * `submission.judged` y recién entonces hace commit del offset (at-least-once).
 * Un mensaje que no se puede deserializar va a la DLQ y se hace commit.
 * Si publicar falla, lanza el error: kafkajs reintenta el mismo mensaje.
 */
export function createMessageHandler(
  deps: WorkerDeps,
): (payload: EachMessagePayload) => Promise<void> {
  const { consumer, producer, logger, metrics } = deps;
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? 3_000;

  return async ({ topic, partition, message, heartbeat }) => {
    const nextOffset = (BigInt(message.offset) + 1n).toString();
    const commit = () => consumer.commitOffsets([{ topic, partition, offset: nextOffset }]);
    const log = logger.child({ topic, partition, offset: message.offset });

    let submission: SubmissionCreated;
    try {
      submission = decodeEvent(Topics.SUBMISSION_CREATED, message.value);
      if (!submission.submissionId) throw new Error('submission_id vacío');
    } catch (error) {
      log.warn({ err: error }, 'mensaje inválido; se envía a la DLQ');
      await producer.send({
        topic: DlqTopics.SUBMISSION_CREATED,
        messages: [
          {
            key: message.key,
            value: message.value,
            headers: {
              ...message.headers,
              'x-dlq-reason': 'deserialization',
              'x-dlq-error': errorMessage(error),
              'x-original-topic': topic,
              'x-original-partition': String(partition),
              'x-original-offset': message.offset,
            },
          },
        ],
      });
      await commit();
      metrics?.recordDlq();
      return;
    }

    const requestId =
      headerString(message.headers, REQUEST_ID_HEADER) || submission.eventId || randomUUID();
    const subLog = log.child({ submissionId: submission.submissionId, requestId });
    subLog.info({ language: submission.language }, 'evaluando submission');

    const started = performance.now();
    const beat = setInterval(() => {
      heartbeat().catch((error: unknown) => subLog.warn({ err: error }, 'heartbeat falló'));
    }, heartbeatIntervalMs);
    let result: JudgeOutcome;
    try {
      result = await deps.judge(submission, { requestId });
    } catch (error) {
      subLog.error({ err: error }, 'el juez lanzó un error inesperado');
      result = {
        verdict: Verdict.INTERNAL_ERROR,
        timeMs: 0,
        memoryKb: 0,
        passedCases: 0,
        totalCases: 0,
      };
    } finally {
      clearInterval(beat);
    }

    const judged = buildJudgedMessage(submission, result);
    await producer.send({
      topic: Topics.SUBMISSION_JUDGED,
      messages: [
        {
          key: judged.key,
          value: judged.value,
          headers: { ...judged.headers, [REQUEST_ID_HEADER]: requestId },
        },
      ],
    });
    await commit();

    const durationMs = performance.now() - started;
    metrics?.recordJudged(result.verdict, durationMs);
    subLog.info(
      {
        verdict: Verdict[result.verdict],
        passedCases: result.passedCases,
        totalCases: result.totalCases,
        timeMs: result.timeMs,
        memoryKb: result.memoryKb,
        durationMs: Math.round(durationMs),
      },
      'submission juzgada',
    );
  };
}
