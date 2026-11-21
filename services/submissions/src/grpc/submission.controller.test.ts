import { describe, expect, it, vi } from 'vitest';
import { RpcException } from '@nestjs/microservices';
import * as grpc from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { Code, ConnectError } from '@connectrpc/connect';
import { ContestStatus } from '@juez/contracts/es';
import { common } from '@juez/contracts/nest';
import { SubmissionController } from './submission.controller.js';
import { createLogger } from '../logger.js';
import { createMetrics } from '../metrics.js';
import type { SubmissionsRepository } from '../repository.js';
import { InvalidTokenError, PublicKeyUnavailableError } from '../auth/jwt-verifier.js';
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

  describe('createSubmission — errores de problems / ranking', () => {
    const request = {
      problemId: mockProblemId,
      language: common.Language.LANGUAGE_CPP17,
      sourceCode: 'int main() {}',
    };
    const contestRequest = { ...request, contestId: mockContestId };

    async function rpcError(promise: Promise<unknown>) {
      const err = await promise.then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(RpcException);
      return (err as RpcException).getError() as { code: number; message: string };
    }

    const failingProblems = (err: unknown) =>
      ({ getProblem: vi.fn().mockRejectedValue(err) }) as unknown as ProblemsClient;
    const failingRanking = (err: unknown) =>
      ({ getContest: vi.fn().mockRejectedValue(err) }) as unknown as RankingClient;

    it('problems responde NotFound → NOT_FOUND', async () => {
      const controller = createController({
        problemsClient: failingProblems(new ConnectError('no existe', Code.NotFound)),
      });
      const e = await rpcError(
        controller.createSubmission(request, metadata as unknown as Metadata),
      );
      expect(e.code).toBe(grpc.status.NOT_FOUND);
      expect(e.message).toContain(mockProblemId);
    });

    it.each([
      ['Unavailable', new ConnectError('down', Code.Unavailable)],
      ['DeadlineExceeded', new ConnectError('timeout', Code.DeadlineExceeded)],
      ['error de red', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })],
    ])('problems con %s → UNAVAILABLE "no responde"', async (_name, err) => {
      const controller = createController({ problemsClient: failingProblems(err) });
      const e = await rpcError(
        controller.createSubmission(request, metadata as unknown as Metadata),
      );
      expect(e.code).toBe(grpc.status.UNAVAILABLE);
      expect(e.message).toMatch(/servicio problems no responde/);
    });

    it('problems con otro error → INTERNAL', async () => {
      const controller = createController({
        problemsClient: failingProblems(new ConnectError('denied', Code.PermissionDenied)),
      });
      const e = await rpcError(
        controller.createSubmission(request, metadata as unknown as Metadata),
      );
      expect(e.code).toBe(grpc.status.INTERNAL);
    });

    it('ranking responde NotFound → NOT_FOUND', async () => {
      const controller = createController({
        rankingClient: failingRanking(new ConnectError('no existe', Code.NotFound)),
      });
      const e = await rpcError(
        controller.createSubmission(contestRequest, metadata as unknown as Metadata),
      );
      expect(e.code).toBe(grpc.status.NOT_FOUND);
      expect(e.message).toContain(mockContestId);
    });

    it.each([
      ['Unavailable', new ConnectError('down', Code.Unavailable)],
      ['DeadlineExceeded', new ConnectError('timeout', Code.DeadlineExceeded)],
      ['error de red', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
    ])('ranking con %s → UNAVAILABLE "no responde"', async (_name, err) => {
      const controller = createController({ rankingClient: failingRanking(err) });
      const e = await rpcError(
        controller.createSubmission(contestRequest, metadata as unknown as Metadata),
      );
      expect(e.code).toBe(grpc.status.UNAVAILABLE);
      expect(e.message).toMatch(/servicio ranking no responde/);
    });
  });

  describe('autenticación', () => {
    const request = {
      problemId: mockProblemId,
      language: common.Language.LANGUAGE_CPP17,
      sourceCode: 'int main() {}',
    };
    const verifierFailingWith = (err: unknown) =>
      ({ verify: vi.fn().mockRejectedValue(err) }) as unknown as JwtVerifier;

    async function codeOf(promise: Promise<unknown>) {
      const err = await promise.then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(RpcException);
      return (err as RpcException).getError() as { code: number; message: string };
    }

    it('token inválido → UNAUTHENTICATED', async () => {
      const controller = createController({
        jwtVerifier: verifierFailingWith(new InvalidTokenError('Token expirado')),
      });
      const e = await codeOf(controller.createSubmission(request, metadata as unknown as Metadata));
      expect(e.code).toBe(grpc.status.UNAUTHENTICATED);
      expect(e.message).toBe('Token expirado');
    });

    it('sin header de authorization → UNAUTHENTICATED', async () => {
      const controller = createController();
      const e = await codeOf(
        controller.getSubmission({ id: mockSubmissionId }, { get: () => undefined } as never),
      );
      expect(e.code).toBe(grpc.status.UNAUTHENTICATED);
    });

    it.each([
      ['Unavailable', new ConnectError('down', Code.Unavailable)],
      ['DeadlineExceeded', new ConnectError('timeout', Code.DeadlineExceeded)],
      ['error de red', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })],
    ])('users con %s → UNAVAILABLE (no UNAUTHENTICATED)', async (_name, cause) => {
      const controller = createController({
        jwtVerifier: verifierFailingWith(new PublicKeyUnavailableError('x', { cause })),
      });
      for (const call of [
        controller.createSubmission(request, metadata as unknown as Metadata),
        controller.getSubmission({ id: mockSubmissionId }, metadata as unknown as Metadata),
        controller.listSubmissions(
          { pageSize: 10, pageToken: '' },
          metadata as unknown as Metadata,
        ),
      ]) {
        const e = await codeOf(call);
        expect(e.code).toBe(grpc.status.UNAVAILABLE);
        expect(e.message).toMatch(/servicio users no responde/);
      }
    });

    it('otro error de users al obtener la llave → INTERNAL', async () => {
      const controller = createController({
        jwtVerifier: verifierFailingWith(
          new PublicKeyUnavailableError('x', {
            cause: new ConnectError('boom', Code.Internal),
          }),
        ),
      });
      const e = await codeOf(controller.getSubmission({ id: mockSubmissionId }, metadata as never));
      expect(e.code).toBe(grpc.status.INTERNAL);
    });

    it('error inesperado del verificador → INTERNAL', async () => {
      const controller = createController({ jwtVerifier: verifierFailingWith(new Error('bug')) });
      const e = await codeOf(controller.getSubmission({ id: mockSubmissionId }, metadata as never));
      expect(e.code).toBe(grpc.status.INTERNAL);
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
