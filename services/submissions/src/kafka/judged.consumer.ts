import { DlqTopics, Topics, decodeEvent } from '@juez/contracts';
import type { SubmissionJudged } from '@juez/contracts/es';
import type { Consumer, EachMessagePayload, Producer } from 'kafkajs';
import type { Logger } from '../logger.js';
import type { Metrics } from '../metrics.js';
import { PROTO_TO_VERDICT_NAME, type SubmissionsRepository } from '../repository.js';

export interface JudgedConsumerDeps {
  consumer: Consumer;
  producer: Producer;
  repo: SubmissionsRepository;
  logger: Logger;
  metrics: Metrics;
}

export class JudgedConsumer {
  private running = false;

  constructor(private readonly deps: JudgedConsumerDeps) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    await this.deps.consumer.connect();
    await this.deps.producer.connect();

    await this.deps.consumer.subscribe({
      topic: Topics.SUBMISSION_JUDGED,
      fromBeginning: false,
    });

    await this.deps.consumer.run({
      autoCommit: false,
      eachMessage: this.handleMessage.bind(this),
    });

    this.deps.logger.info(
      { topic: Topics.SUBMISSION_JUDGED },
      'consumidor submission.judged iniciado',
    );
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    await this.deps.consumer.disconnect().catch(() => {});
  }

  private async handleMessage({ topic, partition, message }: EachMessagePayload): Promise<void> {
    const nextOffset = (BigInt(message.offset) + 1n).toString();
    const commit = () =>
      this.deps.consumer.commitOffsets([{ topic, partition, offset: nextOffset }]);

    const log = this.deps.logger.child({ topic, partition, offset: message.offset });

    let judged: SubmissionJudged;
    try {
      judged = decodeEvent(Topics.SUBMISSION_JUDGED, message.value);
      if (!judged.submissionId) throw new Error('submission_id vacío en el evento');
      if (!judged.eventId) throw new Error('event_id vacío en el evento');
    } catch (err) {
      log.warn({ err }, 'mensaje submission.judged inválido; enviando a DLQ');
      await this.deps.producer.send({
        topic: DlqTopics.SUBMISSION_JUDGED,
        messages: [
          {
            key: message.key,
            value: message.value,
            headers: {
              ...message.headers,
              'x-dlq-reason': 'deserialization_error',
              'x-dlq-error': (err as Error).message,
              'x-original-topic': topic,
              'x-original-partition': String(partition),
              'x-original-offset': message.offset,
            },
          },
        ],
      });
      await commit();
      this.deps.metrics.eventsProcessed.inc({ topic, status: 'dlq' });
      return;
    }

    const subLog = log.child({
      submissionId: judged.submissionId,
      eventId: judged.eventId,
    });

    const verdictName = PROTO_TO_VERDICT_NAME[judged.verdict];
    if (!verdictName) {
      subLog.warn({ verdict: judged.verdict }, 'veredicto desconocido; enviando a DLQ');
      await this.deps.producer.send({
        topic: DlqTopics.SUBMISSION_JUDGED,
        messages: [
          {
            key: message.key,
            value: message.value,
            headers: {
              ...message.headers,
              'x-dlq-reason': 'unknown_verdict',
              'x-original-topic': topic,
            },
          },
        ],
      });
      await commit();
      this.deps.metrics.eventsProcessed.inc({ topic, status: 'dlq' });
      return;
    }

    try {
      const updated = await this.deps.repo.updateVerdict({
        eventId: judged.eventId,
        submissionId: judged.submissionId,
        verdict: verdictName,
        timeMs: judged.timeMs,
        memoryKb: judged.memoryKb,
        passedCases: judged.passedCases,
        totalCases: judged.totalCases,
      });

      if (updated) {
        subLog.info(
          {
            verdict: verdictName,
            timeMs: judged.timeMs,
            memoryKb: judged.memoryKb,
            passedCases: judged.passedCases,
            totalCases: judged.totalCases,
          },
          'veredicto de submission actualizado',
        );
        this.deps.metrics.eventsProcessed.inc({ topic, status: 'processed' });
      } else {
        subLog.info('evento duplicado descartado');
        this.deps.metrics.eventsProcessed.inc({ topic, status: 'duplicate' });
      }

      await commit();
    } catch (err) {
      subLog.error({ err }, 'error al procesar submission.judged en base de datos');
      // No commiteamos el offset para que Kafka reintente el mensaje
      throw err;
    }
  }
}
