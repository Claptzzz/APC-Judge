import { describe, expect, it, vi } from 'vitest';
import { RpcException } from '@nestjs/microservices';
import type { Metadata } from '@grpc/grpc-js';
import { ContestStatus } from '@juez/contracts/es';
import { common } from '@juez/contracts/nest';
import { SubmissionController } from './submission.controller.js';
import { createLogger } from '../logger.js';
import { createMetrics } from '../metrics.js';
import type { SubmissionsRepository } from '../repository.js';
import type { JwtVerifier } from '../auth/jwt-verifier.js';
import type { ProblemsClient } from '../clients/problems.client.js';
import type { RankingClient } from '../clients/ranking.client.js';

describe('SubmissionController', () => {
  const mockUserId = '550e8400-e29b-41d4-a716-446655440000';
  const mockProblemId = '660e8400-e29b-41d4-a716-446655440000';
  const mockContestId = '770e8400-e29b-41d4-a716-446655440000';
  const mockSubmissionId = '880e8400-e29b-41d4-a716-446655440000';

  const fakeJwtVerifier = {
    verify: vi.fn().mockResolvedValue({
      sub: mockUserId,
      username: 'contestant1',
      role: 'CONTESTANT',
    }),
  } as unknown as JwtVerifier;

  const fakeProblemsClient = {
    getProblem: vi.fn().mockResolvedValue({
      id: mockProblemId,
      published: true,
      title: 'Problem 1',
    }),
  } as unknown as ProblemsClient;

  const fakeRankingClient = {
    getContest: vi.fn().mockResolvedValue({
      id: mockContestId,
      status: ContestStatus.RUNNING,
      problemIds: [mockProblemId],
    }),
  } as unknown as RankingClient;

  const fakeRepo = {
    createWithCreatedEvent: vi.fn().mockResolvedValue({
      id: mockSubmissionId,
      userId: mockUserId,
      problemId: mockProblemId,
      contestId: null,
      language: 'CPP17',
      sourceCode: 'int main() {}',
      verdict: 'PENDING',
      timeMs: 0,
      memoryKb: 0,
      passedCases: 0,
      totalCases: 0,
      submittedAt: new Date('2026-11-14T10:00:00Z'),
      judgedAt: null,
    }),
    findById: vi.fn().mockImplementation((id: string) => {
      if (id === mockSubmissionId) {
        return Promise.resolve({
          id: mockSubmissionId,
          userId: mockUserId,
          problemId: mockProblemId,
          contestId: null,
          language: 'CPP17',
          sourceCode: 'int main() {}',
          verdict: 'PENDING',
          timeMs: 0,
          memoryKb: 0,
          passedCases: 0,
          totalCases: 0,
          submittedAt: new Date('2026-11-14T10:00:00Z'),
          judgedAt: null,
        });
      }
      return Promise.resolve(undefined);
    }),
    list: vi.fn().mockResolvedValue({
      submissions: [
        {
          id: mockSubmissionId,
          userId: mockUserId,
          problemId: mockProblemId,
          contestId: null,
          language: 'CPP17',
          sourceCode: 'int main() {}',
          verdict: 'PENDING',
          timeMs: 0,
          memoryKb: 0,
          passedCases: 0,
          totalCases: 0,
          submittedAt: new Date('2026-11-14T10:00:00Z'),
          judgedAt: null,
        },
      ],
      nextPageToken: 'next-page-token',
    }),
  } as unknown as SubmissionsRepository;

  const metadata = {
    get: (key: string) => (key === 'authorization' ? 'Bearer valid-jwt' : undefined),
  };

  const createController = (overrides = {}) => {
    return new SubmissionController(
      ((overrides as Record<string, unknown>).repo as SubmissionsRepository) || fakeRepo,
      ((overrides as Record<string, unknown>).jwtVerifier as JwtVerifier) || fakeJwtVerifier,
      ((overrides as Record<string, unknown>).problemsClient as ProblemsClient) ||
        fakeProblemsClient,
      ((overrides as Record<string, unknown>).rankingClient as RankingClient) || fakeRankingClient,
      createLogger('silent'),
      createMetrics({ defaultMetrics: false }),
    );
  };

  describe('createSubmission', () => {
    it('crea submission correctamente y retorna respuesta', async () => {
      const controller = createController();
      const res = await controller.createSubmission(
        {
          problemId: mockProblemId,
          language: common.Language.LANGUAGE_CPP17,
          sourceCode: 'int main() {}',
        },
        metadata as unknown as Metadata,
      );

      expect(res.submission?.id).toBe(mockSubmissionId);
      expect(res.submission?.userId).toBe(mockUserId);
      expect(res.submission?.sourceCode).toBe('int main() {}');
      expect(res.submission?.verdict).toBe(common.Verdict.VERDICT_PENDING);
    });

    it('falla si el problema no está publicado para un CONTESTANT', async () => {
      const unpublishedProblemsClient = {
        getProblem: vi.fn().mockResolvedValue({
          id: mockProblemId,
          published: false,
        }),
      } as unknown as ProblemsClient;

      const controller = createController({ problemsClient: unpublishedProblemsClient });
      await expect(
        controller.createSubmission(
          {
            problemId: mockProblemId,
            language: common.Language.LANGUAGE_CPP17,
            sourceCode: 'int main() {}',
          },
          metadata as unknown as Metadata,
        ),
      ).rejects.toThrow(RpcException);
    });

    it('falla si contest no está en curso', async () => {
      const finishedRankingClient = {
        getContest: vi.fn().mockResolvedValue({
          id: mockContestId,
          status: ContestStatus.FINISHED,
          problemIds: [mockProblemId],
        }),
      } as unknown as RankingClient;

      const controller = createController({ rankingClient: finishedRankingClient });
      await expect(
        controller.createSubmission(
          {
            problemId: mockProblemId,
            contestId: mockContestId,
            language: common.Language.LANGUAGE_CPP17,
            sourceCode: 'int main() {}',
          },
          metadata as unknown as Metadata,
        ),
      ).rejects.toThrow(RpcException);
    });
  });

  describe('getSubmission', () => {
    it('retorna submission con código fuente para el dueño', async () => {
      const controller = createController();
      const res = await controller.getSubmission(
        { id: mockSubmissionId },
        metadata as unknown as Metadata,
      );
      expect(res.submission?.id).toBe(mockSubmissionId);
      expect(res.submission?.sourceCode).toBe('int main() {}');
    });

    it('retorna código fuente vacío para otro usuario no admin', async () => {
      const otherUserVerifier = {
        verify: vi.fn().mockResolvedValue({
          sub: '999e8400-e29b-41d4-a716-446655440000',
          username: 'other',
          role: 'CONTESTANT',
        }),
      } as unknown as JwtVerifier;

      const controller = createController({ jwtVerifier: otherUserVerifier });
      const res = await controller.getSubmission(
        { id: mockSubmissionId },
        metadata as unknown as Metadata,
      );
      expect(res.submission?.sourceCode).toBe('');
    });

    it('lanza RpcException NOT_FOUND si no existe', async () => {
      const controller = createController();
      await expect(
        controller.getSubmission(
          { id: '000e8400-e29b-41d4-a716-446655440000' },
          metadata as unknown as Metadata,
        ),
      ).rejects.toThrow(RpcException);
    });
  });

  describe('listSubmissions', () => {
    it('retorna lista con sourceCode vacío y next_page_token', async () => {
      const controller = createController();
      const res = await controller.listSubmissions(
        { pageSize: 10, pageToken: '' },
        metadata as unknown as Metadata,
      );
      expect(res.submissions.length).toBe(1);
      expect(res.submissions[0]?.sourceCode).toBe('');
      expect(res.nextPageToken).toBe('next-page-token');
    });
  });
});
