import { setTimeout as delay } from 'node:timers/promises';

export interface RetryOptions {
  /** Intentos totales (incluido el primero). */
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  isRetryable?: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  sleep?: (ms: number) => Promise<unknown>;
}

/** Ejecuta `fn` con reintentos y backoff exponencial. Lanza el último error. */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const { attempts, baseDelayMs, maxDelayMs, isRetryable = () => true, onRetry } = options;
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryable(error)) break;
      const wait = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      onRetry?.(error, attempt, wait);
      await sleep(wait);
    }
  }
  throw lastError;
}
