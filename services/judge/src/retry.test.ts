import { describe, expect, it, vi } from 'vitest';
import { withRetry } from './retry.js';

const noSleep = () => Promise.resolve();

describe('withRetry', () => {
  it('reintenta hasta tener éxito con backoff exponencial acotado', async () => {
    const sleep = vi.fn((_ms: number) => Promise.resolve());
    const onRetry = vi.fn();
    const fn = vi.fn(async (attempt: number) => {
      if (attempt < 4) throw new Error(`falla ${attempt}`);
      return 'ok';
    });
    await expect(
      withRetry(fn, { attempts: 5, baseDelayMs: 100, maxDelayMs: 300, sleep, onRetry }),
    ).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200, 300]);
    expect(onRetry).toHaveBeenCalledTimes(3);
  });

  it('lanza el último error al agotar los intentos', async () => {
    const fn = vi.fn(async (attempt: number) => {
      throw new Error(`falla ${attempt}`);
    });
    await expect(
      withRetry(fn, { attempts: 3, baseDelayMs: 1, maxDelayMs: 1, sleep: noSleep }),
    ).rejects.toThrow('falla 3');
  });

  it('no reintenta errores no transitorios', async () => {
    const fn = vi.fn(async () => {
      throw new Error('permanente');
    });
    await expect(
      withRetry(fn, {
        attempts: 3,
        baseDelayMs: 1,
        maxDelayMs: 1,
        isRetryable: () => false,
        sleep: noSleep,
      }),
    ).rejects.toThrow('permanente');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('usa un sleep real por defecto', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        if (calls++ === 0) throw new Error('una vez');
        return 1;
      },
      { attempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
    );
    expect(result).toBe(1);
  });
});
