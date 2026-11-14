import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GetJudgeSpecResponse } from '@juez/contracts/es';
import type { Logger } from './logger.js';
import { withRetry } from './retry.js';
import type { RetryOptions } from './retry.js';

export interface DownloadedCase {
  id: string;
  ordinal: number;
  inputPath: string;
  outputPath: string;
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface DownloadOptions {
  fetchFn?: FetchFn;
  timeoutMs?: number;
  retry?: Partial<RetryOptions>;
  logger?: Logger;
}

export class DownloadError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

/** 4xx (salvo 408/429) no se reintenta: la URL prefirmada es inválida o expiró. */
export function isRetryableDownloadError(error: unknown): boolean {
  if (error instanceof DownloadError && error.status !== undefined) {
    return error.status >= 500 || error.status === 408 || error.status === 429;
  }
  return true;
}

async function downloadTo(
  url: string,
  path: string,
  fetchFn: FetchFn,
  timeoutMs: number,
): Promise<void> {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new DownloadError(`GET de caso de prueba respondió ${res.status}`, res.status);
  await writeFile(path, Buffer.from(await res.arrayBuffer()));
}

/**
 * Descarga input y output de cada caso (URLs prefirmadas GET) a `<dir>/<ordinal>.in|.out`.
 * Devuelve los casos ordenados por ordinal.
 */
export async function downloadTestcases(
  spec: Pick<GetJudgeSpecResponse, 'testcases'>,
  dir: string,
  options: DownloadOptions = {},
): Promise<DownloadedCase[]> {
  const { fetchFn = fetch, timeoutMs = 30_000, logger } = options;
  await mkdir(dir, { recursive: true });
  const ordered = [...spec.testcases].sort((a, b) => a.ordinal - b.ordinal);
  const cases: DownloadedCase[] = [];
  for (const [index, tc] of ordered.entries()) {
    const base = join(dir, String(index + 1).padStart(4, '0'));
    const downloaded: DownloadedCase = {
      id: tc.id,
      ordinal: tc.ordinal,
      inputPath: `${base}.in`,
      outputPath: `${base}.out`,
    };
    for (const [url, path] of [
      [tc.inputUrl, downloaded.inputPath],
      [tc.outputUrl, downloaded.outputPath],
    ] as const) {
      await withRetry(() => downloadTo(url, path, fetchFn, timeoutMs), {
        attempts: 3,
        baseDelayMs: 250,
        maxDelayMs: 2_000,
        isRetryable: isRetryableDownloadError,
        onRetry: (error, attempt) =>
          logger?.warn({ err: error, attempt, testcaseId: tc.id }, 'descarga falló; reintentando'),
        ...options.retry,
      });
    }
    cases.push(downloaded);
  }
  return cases;
}
