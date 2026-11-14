import { describe, expect, it, vi } from 'vitest';
import { ConnectProblemsClient } from './problems.client.js';
import { ConnectRankingClient } from './ranking.client.js';
import { createLogger } from '../logger.js';

vi.mock('@connectrpc/connect', () => {
  return {
    createClient: vi.fn((service) => {
      if (service.typeName.includes('ProblemService')) {
        return {
          getProblem: vi.fn().mockImplementation(async (req) => {
            if (req.key.value === 'problem-1') {
              return { problem: { id: 'problem-1', title: 'Problem 1' } };
            }
            return { problem: undefined };
          }),
        };
      }
      return {
        getContest: vi.fn().mockImplementation(async (req) => {
          if (req.id === 'contest-1') {
            return { contest: { id: 'contest-1', title: 'Contest 1' } };
          }
          return { contest: undefined };
        }),
      };
    }),
  };
});

vi.mock('@connectrpc/connect-node', () => ({
  createGrpcTransport: vi.fn(() => ({})),
}));

describe('Clients', () => {
  const logger = createLogger('silent');

  describe('ConnectProblemsClient', () => {
    it('obtiene problema exitosamente', async () => {
      const client = new ConnectProblemsClient('localhost:50052', logger);
      const problem = await client.getProblem('problem-1', 'Bearer token');
      expect(problem.id).toBe('problem-1');
    });

    it('lanza error si el problema no se encuentra', async () => {
      const client = new ConnectProblemsClient('localhost:50052', logger);
      await expect(client.getProblem('missing', 'Bearer token')).rejects.toThrow();
    });
  });

  describe('ConnectRankingClient', () => {
    it('obtiene contest exitosamente', async () => {
      const client = new ConnectRankingClient('localhost:50054', logger);
      const contest = await client.getContest('contest-1', 'Bearer token');
      expect(contest.id).toBe('contest-1');
    });

    it('lanza error si el contest no se encuentra', async () => {
      const client = new ConnectRankingClient('localhost:50054', logger);
      await expect(client.getContest('missing', 'Bearer token')).rejects.toThrow();
    });
  });
});
