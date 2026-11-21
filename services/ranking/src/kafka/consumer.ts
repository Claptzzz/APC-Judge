import { setTimeout as delay } from 'node:timers/promises';
import { decodeEvent, dlqTopic, isTopic, Topics } from '@juez/contracts';
import type { Topic } from '@juez/contracts';
import type { SubmissionJudged, UserRegistered } from '@juez/contracts/es';
import type { Consumer, EachMessagePayload, Producer } from 'kafkajs';
import { backoffDelay, DEFAULT_INITIAL_RETRY_MS, DEFAULT_MAX_RETRY_MS } from '../backoff.js';
import type { EventOutcome, EventProcessor } from '../events/processor.js';
import { InvalidEventError } from '../events/processor.js';
import type { Logger } from '../logger.js';
import type { Metrics } from '../metrics.js';
import { ConsumerReadiness } from './kafka.js';

type DecodedEvent =
  | { topic: typeof Topics.USER_REGISTERED; event: UserRegistered }
  | { topic: typeof Topics.SUBMISSION_JUDGED; event: SubmissionJudged };

export const CONSUMED_TOPICS: Topic[] = [Topics.USER_REGISTERED, Topics.SUBMISSION_JUDGED];

/**
 * Error de datos de Postgres (clase 22: data exception; 23: integrity constraint) que no se
 * arregla reintentando. Busca el SQLSTATE en la cadena de `cause` (drizzle envuelve el error).
 */
export function isPermanentDbError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^2[23][0-9A-Z]{3}$/.test(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export interface RankingConsumerDeps {
  consumer: Consumer;
  producer: Producer;
  processor: EventProcessor;
  logger: Logger;
  metrics?: Metrics;
}

export interface RankingConsumerOptions {
  /** Backoff de los reintentos de arranque (tope 30 s). */
  initialRetryMs?: number;
  maxRetryMs?: number;
  /** Intentos de procesar un mensaje antes de rendirse (DLQ o re-entrega). */
  processingAttempts?: number;
  processingRetryMs?: number;
}

/**
 * Consumidor de `user.registered` y `submission.judged` (mismo group, `fromBeginning: true`
 * para que un ranking nuevo reconstruya los usernames re-consumiendo el log).
 *
 * - Commit manual del offset solo después de procesar.
 * - Mensajes que no se pueden deserializar o con datos inválidos -> `<topic>.dlq`.
 * - Errores al procesar: hasta N intentos con backoff. Si el error es de datos (permanente)
 *   el mensaje va a la DLQ; si es transitorio (BD caída) se relanza sin commit para que
 *   kafkajs lo vuelva a entregar: nunca se pierde un evento por una caída de la BD.
 */
export class RankingConsumer {
  readonly readiness = new ConsumerReadiness();
  private running = false;
  private starting = false;
  private stopped = false;
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | undefined;
  private readonly opts: Required<RankingConsumerOptions>;

  constructor(
    private readonly deps: RankingConsumerDeps,
    opts: RankingConsumerOptions = {},
  ) {
    this.opts = {
      initialRetryMs: opts.initialRetryMs ?? DEFAULT_INITIAL_RETRY_MS,
      maxRetryMs: opts.maxRetryMs ?? DEFAULT_MAX_RETRY_MS,
      processingAttempts: opts.processingAttempts ?? 5,
      processingRetryMs: opts.processingRetryMs ?? 200,
    };
    this.readiness.track(deps.consumer);
    // Si kafkajs decide no reiniciar tras un crash, lo volvemos a arrancar con backoff.
    deps.consumer.on(deps.consumer.events.CRASH, (event) => {
      if (event.payload.restart || this.stopped) return;
      this.running = false;
      this.deps.logger.error(
        { err: event.payload.error },
        'consumidor caído sin reinicio automático; reintentando',
      );
      void this.disconnectAll().then(() => this.scheduleRetry());
    });
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Intenta arrancar el consumidor. Nunca rechaza: si Kafka no está disponible programa
   * reintentos en segundo plano con backoff exponencial hasta conectar o hasta `stop()`.
   */
  async start(): Promise<void> {
    if (this.running || this.starting) return;
    this.stopped = false;
    this.clearRetry();
    this.starting = true;
    try {
      await this.deps.consumer.connect();
      await this.deps.producer.connect();
      await this.deps.consumer.subscribe({ topics: CONSUMED_TOPICS, fromBeginning: true });
      await this.deps.consumer.run({
        autoCommit: false,
        eachMessage: (payload) => this.handleMessage(payload),
      });
      if (this.stopped) {
        await this.disconnectAll();
        return;
      }
      this.running = true;
      this.attempt = 0;
      this.deps.logger.info({ topics: CONSUMED_TOPICS }, 'consumidor kafka iniciado');
    } catch (err) {
      await this.disconnectAll();
      if (!this.stopped) {
        this.deps.logger.warn({ err }, 'no se pudo iniciar el consumidor kafka');
        this.scheduleRetry();
      }
    } finally {
      this.starting = false;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearRetry();
    this.running = false;
    await this.disconnectAll();
  }

  private async disconnectAll(): Promise<void> {
    await this.deps.consumer.disconnect().catch(() => {});
    await this.deps.producer.disconnect().catch(() => {});
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const delayMs = backoffDelay(this.attempt, this.opts.initialRetryMs, this.opts.maxRetryMs);
    this.attempt++;
    this.deps.logger.info(
      { delayMs, attempt: this.attempt },
      'reintentando arranque del consumidor',
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

  /** Deserializa el valor según el topic. Lanza si no es protobuf válido. */
  private decode(topic: Topic, value: Buffer | null): DecodedEvent {
    if (topic === Topics.USER_REGISTERED) {
      return { topic, event: decodeEvent(Topics.USER_REGISTERED, value) };
    }
    if (topic === Topics.SUBMISSION_JUDGED) {
      return { topic, event: decodeEvent(Topics.SUBMISSION_JUDGED, value) };
    }
    throw new Error(`topic no consumido: ${topic}`);
  }

  private apply(decoded: DecodedEvent): Promise<EventOutcome> {
    return decoded.topic === Topics.USER_REGISTERED
      ? this.deps.processor.userRegistered(decoded.event)
      : this.deps.processor.submissionJudged(decoded.event);
  }

  /** Expuesto para los tests. */
  async handleMessage({ topic, partition, message, heartbeat }: EachMessagePayload): Promise<void> {
    const log = this.deps.logger.child({ topic, partition, offset: message.offset });
    const commit = () =>
      this.deps.consumer.commitOffsets([
        { topic, partition, offset: (BigInt(message.offset) + 1n).toString() },
      ]);
    const count = (status: string) => this.deps.metrics?.eventsProcessed.inc({ topic, status });
    const toDlq = async (reason: string, err: unknown) => {
      await this.sendToDlq(topic as Topic, partition, message, reason, err);
      count('dlq');
      await commit();
    };

    if (!isTopic(topic)) {
      log.warn('mensaje de un topic inesperado; se ignora');
      await commit();
      return;
    }

    let decoded: DecodedEvent;
    try {
      decoded = this.decode(topic, message.value);
    } catch (err) {
      log.warn({ err }, 'mensaje que no se puede deserializar; enviando a la DLQ');
      await toDlq('deserialization_error', err);
      return;
    }
    const eventLog = log.child({ eventId: decoded.event.eventId });

    for (let attempt = 1; ; attempt++) {
      try {
        const outcome = await this.apply(decoded);
        eventLog.info({ outcome }, 'evento aplicado');
        count(outcome);
        await commit();
        return;
      } catch (err) {
        if (err instanceof InvalidEventError) {
          eventLog.warn({ err }, 'evento con datos inválidos; enviando a la DLQ');
          await toDlq('invalid_event', err);
          return;
        }
        if (attempt >= this.opts.processingAttempts) {
          if (isPermanentDbError(err)) {
            eventLog.error({ err, attempt }, 'error permanente al aplicar el evento; a la DLQ');
            await toDlq('processing_error', err);
            return;
          }
          eventLog.error({ err, attempt }, 'error al aplicar el evento; se re-entregará');
          throw err;
        }
        const wait = backoffDelay(attempt - 1, this.opts.processingRetryMs, this.opts.maxRetryMs);
        eventLog.warn({ err, attempt, delayMs: wait }, 'error al aplicar el evento; reintentando');
        await delay(wait);
        await heartbeat().catch(() => {});
      }
    }
  }

  private async sendToDlq(
    topic: Topic,
    partition: number,
    message: EachMessagePayload['message'],
    reason: string,
    err: unknown,
  ): Promise<void> {
    await this.deps.producer.send({
      topic: dlqTopic(topic),
      messages: [
        {
          key: message.key,
          value: message.value,
          headers: {
            ...message.headers,
            'x-dlq-reason': reason,
            'x-dlq-error': err instanceof Error ? err.message : String(err),
            'x-original-topic': topic,
            'x-original-partition': String(partition),
            'x-original-offset': message.offset,
          },
        },
      ],
    });
  }
}
