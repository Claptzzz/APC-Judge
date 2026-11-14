import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DownloadError, downloadTestcases, isRetryableDownloadError } from './testcases.js';
import { makeSpec, silentLogger } from './test-utils/index.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'judge-dl-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fastRetry = { sleep: () => Promise.resolve(), baseDelayMs: 1, maxDelayMs: 1 };

describe('downloadTestcases', () => {
  it('descarga input y output de cada caso ordenados por ordinal', async () => {
    const spec = makeSpec([
      { input: '', output: '' },
      { input: '', output: '' },
    ]);
    spec.testcases.reverse();
    const fetchFn = vi.fn(async (url: string) => new Response(`contenido de ${url}`));
    const cases = await downloadTestcases(spec, join(dir, 'cases'), { fetchFn });
    expect(cases.map((c) => c.ordinal)).toEqual([1, 2]);
    expect(await readFile(cases[0]!.inputPath, 'utf8')).toBe('contenido de mem://0/in');
    expect(await readFile(cases[1]!.outputPath, 'utf8')).toBe('contenido de mem://1/out');
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it('reintenta errores 5xx y de red', async () => {
    const spec = makeSpec([{ input: '', output: '' }]);
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new TypeError('fetch failed');
      if (calls === 2) return new Response('err', { status: 503 });
      return new Response('ok');
    });
    const cases = await downloadTestcases(spec, dir, {
      fetchFn,
      retry: fastRetry,
      logger: silentLogger,
    });
    expect(cases).toHaveLength(1);
    expect(calls).toBe(4);
  });

  it('no reintenta un 403 (URL prefirmada inválida o expirada)', async () => {
    const spec = makeSpec([{ input: '', output: '' }]);
    const fetchFn = vi.fn(async () => new Response('forbidden', { status: 403 }));
    await expect(
      downloadTestcases(spec, dir, { fetchFn, retry: fastRetry }),
    ).rejects.toBeInstanceOf(DownloadError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('isRetryableDownloadError', () => {
  it('clasifica por status HTTP', () => {
    expect(isRetryableDownloadError(new DownloadError('x', 500))).toBe(true);
    expect(isRetryableDownloadError(new DownloadError('x', 429))).toBe(true);
    expect(isRetryableDownloadError(new DownloadError('x', 404))).toBe(false);
    expect(isRetryableDownloadError(new Error('red'))).toBe(true);
  });
});
