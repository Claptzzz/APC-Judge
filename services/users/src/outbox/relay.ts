import type { Logger } from '../logger.js';
import type { EventPublisher } from './publisher.js';
import type { OutboxStore } from './store.js';

export interface OutboxRelayOptions {
  pollIntervalMs: number;
  batchSize: number;
  /** Tope del backoff exponencial ante errores. */
  maxBackoffMs?: number;
  logger: Logger;
  onPublished?: (count: number) => void;
}

/**
 * Relay del outbox: hace polling de la tabla, publica en Kafka y marca como publicado.
 * Entrega at-least-once: si el proceso cae entre publicar y confirmar la transacción,
 * los mensajes se vuelven a enviar (los consumidores deduplican por event_id).
 */
export class OutboxRelay {
  private running = false;
  private loopPromise: Promise<void> | undefined;
  private wake: (() => void) | undefined;
  private consecutiveFailures = 0;
  private lastError: string | undefined;
  private readonly maxBackoffMs: number;

  constructor(
    private readonly store: OutboxStore,
    private readonly publisher: EventPublisher,
    private readonly opts: OutboxRelayOptions,
  ) {
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
  }

  get status() {
    return {
      running: this.running,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
    };
  }

  /** Una pasada: conecta el productor y publica un lote. Devuelve cuántos mensajes publicó. */
  async runOnce(): Promise<number> {
    await this.publisher.connect();
    const count = await this.store.publishPending(this.opts.batchSize, (msgs) =>
      this.publisher.publish(msgs),
    );
    if (count > 0) {
      this.opts.logger.debug({ count }, 'outbox: mensajes publicados');
      this.opts.onPublished?.(count);
    }
    return count;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.loop();
  }

  /** Detiene el polling y espera a que termine la pasada en curso. */
  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loopPromise;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let delay = this.opts.pollIntervalMs;
      try {
        const count = await this.runOnce();
        if (this.consecutiveFailures > 0) {
          this.opts.logger.info('outbox: relay recuperado');
        }
        this.consecutiveFailures = 0;
        this.lastError = undefined;
        // Lote lleno: probablemente quedan más pendientes, seguir sin esperar.
        if (count >= this.opts.batchSize) delay = 0;
      } catch (err) {
        this.consecutiveFailures++;
        this.lastError = (err as Error).message;
        delay = Math.min(
          this.opts.pollIntervalMs * 2 ** this.consecutiveFailures,
          this.maxBackoffMs,
        );
        this.opts.logger.warn(
          { err, failures: this.consecutiveFailures, retryInMs: delay },
          'outbox: error al publicar; se reintentará',
        );
      }
      if (this.running && delay > 0) await this.sleep(delay);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    });
  }
}
