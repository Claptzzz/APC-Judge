import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Code, ConnectError } from '@connectrpc/connect';
import type * as ConnectModule from '@connectrpc/connect';
import { ConnectProblemsClient } from './problems.client.js';
import { ConnectRankingClient } from './ranking.client.js';
import { classifyUpstreamError, DEFAULT_UPSTREAM_TIMEOUT_MS } from './errors.js';
import { createLogger } from '../logger.js';

const getProblem = vi.fn();
const getContest = vi.fn();

vi.mock('@connectrpc/connect', async (importOriginal) => {
  const actual = await importOriginal<typeof ConnectModule>();
  return {
    ...actual,
    createClient: vi.fn((service: { typeName: string }) =>
      service.typeName.includes('ProblemService') ? { getProblem } : { getContest },
    ),
  };
});

vi.mock('@connectrpc/connect-node', () => ({
  createGrpcTransport: vi.fn(() => ({})),
}));

function netError(code: string): Error {
  return Object.assign(new Error(`connect ${code}`), { code });
}

describe('classifyUpstreamError', () => {
  it('Code.NotFound → not_found', () => {
    expect(classifyUpstreamError(new ConnectError('x', Code.NotFound))).toBe('not_found');
  });

  it.each([Code.Unavailable, Code.DeadlineExceeded])('Code %s → unavailable', (code) => {
    expect(classifyUpstreamError(new ConnectError('x', code))).toBe('unavailable');
  });

  it.each(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH'])(
    'error de red %s (crudo o como causa de un ConnectError) → unavailable',
    (code) => {
      expect(classifyUpstreamError(netError(code))).toBe('unavailable');
      expect(
        classifyUpstreamError(
          new ConnectError('x', Code.Unknown, undefined, undefined, netError(code)),
        ),
      ).toBe('unavailable');
      expect(classifyUpstreamError(new Error('envoltorio', { cause: netError(code) }))).toBe(
        'unavailable',
      );
    },
  );

  it('otros errores → other', () => {
    expect(classifyUpstreamError(new ConnectError('x', Code.PermissionDenied))).toBe('other');
    expect(classifyUpstreamError(new ConnectError('x', Code.Internal))).toBe('other');
    expect(classifyUpstreamError(new Error('boom'))).toBe('other');
    expect(classifyUpstreamError('string')).toBe('other');
    expect(classifyUpstreamError(undefined)).toBe('other');
  });
});

describe('Clients', () => {
  const logger = createLogger('silent');

  beforeEach(() => {
    getProblem.mockReset();
    getContest.mockReset();
  });

  describe('ConnectProblemsClient', () => {
    it('obtiene problema con header de auth y timeout por llamada', async () => {
      getProblem.mockResolvedValue({ problem: { id: 'problem-1', title: 'Problem 1' } });
      const client = new ConnectProblemsClient('localhost:50052', logger);
      const problem = await client.getProblem('problem-1', 'Bearer token');

      expect(problem.id).toBe('problem-1');
      expect(getProblem).toHaveBeenCalledWith(
        { key: { case: 'id', value: 'problem-1' } },
        { headers: { authorization: 'Bearer token' }, timeoutMs: DEFAULT_UPSTREAM_TIMEOUT_MS },
      );
      expect(DEFAULT_UPSTREAM_TIMEOUT_MS).toBe(3000);
    });

    it('respeta un timeout configurado y omite el header sin token', async () => {
      getProblem.mockResolvedValue({ problem: { id: 'p' } });
      const client = new ConnectProblemsClient('localhost:50052', logger, 500);
      await client.getProblem('p');
      expect(getProblem).toHaveBeenCalledWith(expect.anything(), { headers: {}, timeoutMs: 500 });
    });

    it('respuesta sin problema → ConnectError NotFound', async () => {
      getProblem.mockResolvedValue({ problem: undefined });
      const client = new ConnectProblemsClient('localhost:50052', logger);
      const err = await client.getProblem('missing').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConnectError);
      expect((err as ConnectError).code).toBe(Code.NotFound);
    });

    it('propaga los errores del transporte para que el controlador los clasifique', async () => {
      getProblem.mockRejectedValue(new ConnectError('timeout', Code.DeadlineExceeded));
      const client = new ConnectProblemsClient('localhost:50052', logger);
      const err = await client.getProblem('p').catch((e: unknown) => e);
      expect(classifyUpstreamError(err)).toBe('unavailable');
    });
  });

  describe('ConnectRankingClient', () => {
    it('obtiene contest con timeout por llamada', async () => {
      getContest.mockResolvedValue({ contest: { id: 'contest-1', title: 'Contest 1' } });
      const client = new ConnectRankingClient('localhost:50054', logger);
      const contest = await client.getContest('contest-1', 'Bearer token');

      expect(contest.id).toBe('contest-1');
      expect(getContest).toHaveBeenCalledWith(
        { id: 'contest-1' },
        { headers: { authorization: 'Bearer token' }, timeoutMs: DEFAULT_UPSTREAM_TIMEOUT_MS },
      );
    });

    it('respuesta sin contest → ConnectError NotFound', async () => {
      getContest.mockResolvedValue({ contest: undefined });
      const client = new ConnectRankingClient('localhost:50054', logger, 100);
      const err = await client.getContest('missing').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConnectError);
      expect((err as ConnectError).code).toBe(Code.NotFound);
    });
  });
});
