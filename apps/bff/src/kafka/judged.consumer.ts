import { decodeEvent, Topics } from '@juez/contracts';
import type { Consumer, EachMessagePayload } from 'kafkajs';
import { backoffDelay, DEFAULT_INITIAL_RETRY_MS, DEFAULT_MAX_RETRY_MS } from '../backoff.js';
import { scoreboardChannel, submissionChannel, toJudgedEvent } from '../events/judged.js';
import type { JudgedEvent } from '../events/judged.js';
import type { PubSub } from '../events/pubsub.js';
import type { Logger } from '../logger.js';
import type { Metrics } from '../metrics.js';
import { ConsumerReadiness } from './readiness.js';
import type { ConsumerReadinessStatus } from './readiness.js';

/** Lo que la app necesita del consumidor (arranque, apagado y readiness). */
export interface ConsumerHandle {
  readiness: { status(): ConsumerReadinessStatus };
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface JudgedConsumerDeps {
  consumer: Consumer;
  pubsub: PubSub<JudgedEvent>;
  logger: Logger;
  metrics?: Pick<Metrics, 'eventsProcessed'>;
}

export interface JudgedConsumerOptions {
  initialRetryMs?: number;
  maxRetryMs?: number;
  /** Cuántos event_id recientes se recuerdan para descartar duplicados. */
  dedupeSize?: number;
}

/**
 * Consume `submission.judged` y lo publica en el PubSub en memoria, de donde lo leen las
 * subscriptions `submissionUpdated` y `scoreboardUpdated`.
 *
 * - El group id es único por réplica (prefijo + hostname) y la suscripción es sin
 *   `fromBeginning`: cada réplica recibe todos los veredictos desde que arranca.
 * - Commit manual del offset después de publicar; duplicados descartados por `event_id`
 *   (memoria acotada, porque la idempotencia aquí solo evita avisos repetidos).
 * - Un mensaje que no se puede deserializar se registra y se salta (sin DLQ: ver la ficha).
 * - No hace llamadas gRPC al procesar: solo usa los datos del evento.
 */
export class JudgedConsumer implements ConsumerHandle {
  readonly readiness = new ConsumerReadiness();
  private running = false;
  private starting = false;
  private stopped = false;
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | undefined;
  private readonly seen = new Set<string>();
  private readonly initialRetryMs: number;
  private readonly maxRetryMs: number;
  private readonly dedupeSize: number;

  constructor(
    private readonly deps: JudgedConsumerDeps,
    opts: JudgedConsumerOptions = {},
  ) {
    this.initialRetryMs = opts.initialRetryMs ?? DEFAULT_INITIAL_RETRY_MS;
    this.maxRetryMs = opts.maxRetryMs ?? DEFAULT_MAX_RETRY_MS;
    this.dedupeSize = opts.dedupeSize ?? 10_000;
    this.readiness.track(deps.consumer);
    // Si kafkajs no reinicia solo tras un crash (error no reintentable), se rearranca.
    deps.consumer.on(deps.consumer.events.CRASH, (event) => {
      if (event.payload.restart || this.stopped) return;
      this.running = false;
      this.deps.logger.error(
        { err: event.payload.error },
        'consumidor submission.judged caído sin reinicio automático; reintentando',
      );
      void this.deps.consumer.disconnect().catch(() => {});
      this.scheduleRetry();
    });
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Nunca rechaza: si Kafka no responde, reintenta con backoff (tope 30 s) hasta `stop()`. */
  async start(): Promise<void> {
    if (this.running || this.starting) return;
    this.stopped = false;
    this.clearRetry();
    this.starting = true;
    try {
      await this.deps.consumer.connect();
      await this.deps.consumer.subscribe({ topic: Topics.SUBMISSION_JUDGED, fromBeginning: false });
      await this.deps.consumer.run({
        autoCommit: false,
        eachMessage: (payload) => this.handleMessage(payload),
      });
      if (this.stopped) {
        await this.deps.consumer.disconnect().catch(() => {});
        return;
      }
      this.running = true;
      this.attempt = 0;
      this.deps.logger.info(
        { topic: Topics.SUBMISSION_JUDGED },
        'consumidor submission.judged iniciado',
      );
    } catch (err) {
      await this.deps.consumer.disconnect().catch(() => {});
      if (!this.stopped) {
        this.deps.logger.warn({ err }, 'no se pudo iniciar el consumidor submission.judged');
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
    await this.deps.consumer.disconnect().catch(() => {});
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const delayMs = backoffDelay(this.attempt, this.initialRetryMs, this.maxRetryMs);
    this.attempt++;
    this.deps.logger.info(
      { delayMs, attempt: this.attempt },
      'reintentando el consumidor submission.judged',
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

  /** true si el event_id ya se procesó (y lo recuerda si no). */
  private isDuplicate(eventId: string): boolean {
    if (this.seen.has(eventId)) return true;
    this.seen.add(eventId);
    if (this.seen.size > this.dedupeSize) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return false;
  }

  private async handleMessage({ topic, partition, message }: EachMessagePayload): Promise<void> {
    const commit = () =>
      this.deps.consumer.commitOffsets([
        { topic, partition, offset: (BigInt(message.offset) + 1n).toString() },
      ]);
    const log = this.deps.logger.child({ topic, partition, offset: message.offset });

    let event: JudgedEvent;
    try {
      const decoded = decodeEvent(Topics.SUBMISSION_JUDGED, message.value);
      if (!decoded.submissionId || !decoded.eventId) {
        throw new Error('evento sin submission_id o event_id');
      }
      event = toJudgedEvent(decoded);
    } catch (err) {
      // submissions y ranking ya lo mandan a la DLQ; el BFF no duplica el mensaje allí.
      log.warn({ err }, 'mensaje submission.judged inválido; se descarta');
      this.deps.metrics?.eventsProcessed.inc({ topic, status: 'invalid' });
      await commit();
      return;
    }

    if (this.isDuplicate(event.eventId)) {
      log.debug({ eventId: event.eventId }, 'evento duplicado descartado');
      this.deps.metrics?.eventsProcessed.inc({ topic, status: 'duplicate' });
      await commit();
      return;
    }

    this.deps.pubsub.publish(submissionChannel(event.submissionId), event);
    if (event.contestId) this.deps.pubsub.publish(scoreboardChannel(event.contestId), event);
    log.info(
      {
        eventId: event.eventId,
        submissionId: event.submissionId,
        contestId: event.contestId,
        verdict: event.verdict,
      },
      'veredicto publicado a las subscriptions',
    );
    this.deps.metrics?.eventsProcessed.inc({ topic, status: 'processed' });
    await commit();
  }
}
