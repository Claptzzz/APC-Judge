export const DEFAULT_INITIAL_RETRY_MS = 1_000;
export const DEFAULT_MAX_RETRY_MS = 30_000;

/** Backoff exponencial: initial · 2^attempt, con tope en max. */
export function backoffDelay(
  attempt: number,
  initialMs = DEFAULT_INITIAL_RETRY_MS,
  maxMs = DEFAULT_MAX_RETRY_MS,
): number {
  return Math.min(initialMs * 2 ** attempt, maxMs);
}
