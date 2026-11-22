export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterMs: number };

/**
 * Rate limit en memoria por clave (ventana deslizante): como mucho `limit` usos en
 * `windowMs`. Cada réplica del BFF lleva su propia cuenta.
 */
export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  tryAcquire(key: string): RateLimitResult {
    const now = this.now();
    const since = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return { allowed: false, retryAfterMs: Math.max(0, recent[0]! + this.windowMs - now) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.prune(since);
    return { allowed: true };
  }

  private prune(since: number): void {
    for (const [key, times] of this.hits) {
      if (times.every((t) => t <= since)) this.hits.delete(key);
    }
  }
}
