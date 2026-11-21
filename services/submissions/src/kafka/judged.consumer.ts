import { DlqTopics, Topics, decodeEvent } from '@juez/contracts';
import type { SubmissionJudged } from '@juez/contracts/es';
import type { Consumer, EachMessagePayload, Producer } from 'kafkajs';
import type { Logger } from '../logger.js';
import type { Metrics } from '../metrics.js';
import { PROTO_TO_VERDICT_NAME, type SubmissionsRepository } from '../repository.js';
import { backoffDelay, DEFAULT_INITIAL_RETRY_MS, DEFAULT_MAX_RETRY_MS } from '../backoff.js';
import { ConsumerReadiness } from './readiness.js';

export interface JudgedConsumerDeps {
  consumer: Consumer;
  producer: Producer;
  repo: SubmissionsRepository;
  logger: Logger;
  metrics: Metrics;
}

export interface JudgedConsumerOptions {
  /** Espera antes del primer reintento de arranque (se duplica en cada fallo). */
  initialRetryMs?: number;
  /** Tope del backoff exponencial. */
  maxRetryMs?: number;
}

export class JudgedConsumer {
  /** true solo cuando connect + subscribe + run terminaron bien. */
  private running = false;
  private starting = false;
  private stopped = false;
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | undefined;
  private readonly initialRetryMs: number;
  private readonly maxRetryMs: number;
  readonly readiness = new ConsumerReadiness();

  constructor(
    private readonly deps: JudgedConsumerDeps,
    opts: JudgedConsumerOptions = {},
  ) {
    this.initialRetryMs = opts.initialRetryMs ?? DEFAULT_INITIAL_RETRY_MS;
    this.maxRetryMs = opts.maxRetryMs ?? DEFAULT_MAX_RETRY_MS;
    this.readiness.track(deps.consumer);
    // Si kafkajs decide no reiniciar tras un crash (error no reintentable), el consumidor
    // queda desconectado: lo volvemos a arrancar con el mismo backoff.
    deps.consumer.on(deps.consumer.events.CRASH, (event) => {
      if (event.payload.restart || this.stopped) return;
      this.running = false;
      this.deps.logger.error(
        { err: event.payload.error },
        'consumidor submission.judged caído sin reinicio automático; reintentando',
      );
      this.scheduleRetry();
    });
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Intenta arrancar el consumidor. Nunca rechaza: si falla, programa reintentos en segundo
   * plano con backoff exponencial (tope `maxRetryMs`) hasta conectar o hasta `stop()`.
   */
  async start(): Promise<void> {
    if (this.running || this.starting) return;
    this.stopped = false;
    this.clearRetry();
    this.starting = true;
    try {
      await this.connectAndRun();
      if (this.stopped) {
        // stop() llegó mientras arrancábamos: no dejar el consumidor colgando.
        await this.disconnectAll();
        return;
      }
      this.running = true;
      this.attempt = 0;
      this.deps.logger.info(
        { topic: Topics.SUBMISSION_JUDGED },
        'consumidor submission.judged iniciado',
      );
    } catch (err) {
      await this.disconnectAll();
      if (!this.stopped) {
        this.deps.logger.warn({ err }, 'no se pudo iniciar consumidor submission.judged');
        this.scheduleRetry();
      }
    } finally {
      this.starting = false;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearRetry();
    const wasRunning = this.running;
    this.running = false;
    if (wasRunning) await this.disconnectAll();
  }

  private async connectAndRun(): Promise<void> {
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
  }

  private async disconnectAll(): Promise<void> {
    await this.deps.consumer.disconnect().catch(() => {});
    await this.deps.producer.disconnect().catch(() => {});
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const delayMs = backoffDelay(this.attempt, this.initialRetryMs, this.maxRetryMs);
    this.attempt++;
    this.deps.logger.info(
      { delayMs, attempt: this.attempt },
      'reintentando arranque del consumidor submission.judged',
    );
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.start();
    }, delayMs);
    this.retryTimer.unref();
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
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
