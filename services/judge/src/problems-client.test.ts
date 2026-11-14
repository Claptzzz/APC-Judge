import { Code, ConnectError, createClient, createRouterTransport } from '@connectrpc/connect';
import { ProblemService } from '@juez/contracts/es';
import { describe, expect, it, vi } from 'vitest';
import {
  createJudgeSpecSource,
  createProblemsTransport,
  isRetryableRpcError,
  REQUEST_ID_HEADER,
} from './problems-client.js';
import { silentLogger } from './test-utils/index.js';

function clientWith(impl: Parameters<typeof createRouterTransport>[0]) {
  return createClient(ProblemService, createRouterTransport(impl));
}

const fastRetry = { sleep: () => Promise.resolve(), baseDelayMs: 1, maxDelayMs: 1 };

describe('createJudgeSpecSource', () => {
  it('llama a GetJudgeSpec propagando x-request-id', async () => {
    const seen: string[] = [];
    const client = clientWith(({ service }) =>
      service(ProblemService, {
        getJudgeSpec(req, ctx) {
          seen.push(ctx.requestHeader.get(REQUEST_ID_HEADER) ?? '');
          return { problemId: req.problemId, timeLimitMs: 1000, memoryLimitMb: 64 };
        },
      }),
    );
    const spec = await createJudgeSpecSource(client).getJudgeSpec('p-1', 'req-1');
    expect(spec.problemId).toBe('p-1');
    expect(spec.timeLimitMs).toBe(1000);
    expect(seen).toEqual(['req-1']);
  });

  it('reintenta errores transitorios y luego responde', async () => {
    let calls = 0;
    const client = clientWith(({ service }) =>
      service(ProblemService, {
        getJudgeSpec(req) {
          if (++calls < 3) throw new ConnectError('caído', Code.Unavailable);
          return { problemId: req.problemId };
        },
      }),
    );
    const warn = vi.spyOn(silentLogger, 'warn');
    const source = createJudgeSpecSource(client, { logger: silentLogger, retry: fastRetry });
    await expect(source.getJudgeSpec('p-1', 'r')).resolves.toMatchObject({ problemId: 'p-1' });
    expect(calls).toBe(3);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('se rinde tras los reintentos y no reintenta NotFound', async () => {
    let calls = 0;
    const unavailable = clientWith(({ service }) =>
      service(ProblemService, {
        getJudgeSpec() {
          calls++;
          throw new ConnectError('caído', Code.Unavailable);
        },
      }),
    );
    await expect(
      createJudgeSpecSource(unavailable, { retry: fastRetry }).getJudgeSpec('p', 'r'),
    ).rejects.toThrow(/caído/);
    expect(calls).toBe(4);

    calls = 0;
    const notFound = clientWith(({ service }) =>
      service(ProblemService, {
        getJudgeSpec() {
          calls++;
          throw new ConnectError('no existe', Code.NotFound);
        },
      }),
    );
    await expect(
      createJudgeSpecSource(notFound, { retry: fastRetry }).getJudgeSpec('p', 'r'),
    ).rejects.toThrow(/no existe/);
    expect(calls).toBe(1);
  });
});

describe('isRetryableRpcError', () => {
  it('clasifica códigos gRPC', () => {
    expect(isRetryableRpcError(new ConnectError('x', Code.DeadlineExceeded))).toBe(true);
    expect(isRetryableRpcError(new ConnectError('x', Code.InvalidArgument))).toBe(false);
    expect(isRetryableRpcError(new Error('socket hang up'))).toBe(true);
  });
});

describe('createProblemsTransport', () => {
  it('crea un transporte gRPC', () => {
    expect(createProblemsTransport('http://localhost:50052')).toHaveProperty('unary');
  });
});
