import { Controller, Inject } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import * as grpc from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { common, submissions } from '@juez/contracts/nest';
import { ContestStatus } from '@juez/contracts/es';
import { extractBearerToken } from '../auth/jwt-verifier.js';
import type { JwtVerifier, TokenClaims } from '../auth/jwt-verifier.js';
import { classifyUpstreamError } from '../clients/errors.js';
import type { ProblemsClient } from '../clients/problems.client.js';
import type { RankingClient } from '../clients/ranking.client.js';
import type { LanguageName, SubmissionRow, VerdictName } from '../db/schema.js';
import type { Logger } from '../logger.js';
import type { Metrics } from '../metrics.js';
import type { SubmissionsRepository } from '../repository.js';
import { createSubmissionSchema, DEFAULT_PAGE_SIZE, isUuid, MAX_PAGE_SIZE } from '../validation.js';

function dateToTimestamp(date: Date): { seconds: number; nanos: number } {
  const ms = date.getTime();
  return {
    seconds: Math.floor(ms / 1000),
    nanos: (ms % 1000) * 1_000_000,
  };
}

const VERDICT_TO_NEST: Record<VerdictName, common.Verdict> = {
  PENDING: common.Verdict.VERDICT_PENDING,
  JUDGING: common.Verdict.VERDICT_JUDGING,
  ACCEPTED: common.Verdict.VERDICT_ACCEPTED,
  WRONG_ANSWER: common.Verdict.VERDICT_WRONG_ANSWER,
  TIME_LIMIT_EXCEEDED: common.Verdict.VERDICT_TIME_LIMIT_EXCEEDED,
  MEMORY_LIMIT_EXCEEDED: common.Verdict.VERDICT_MEMORY_LIMIT_EXCEEDED,
  RUNTIME_ERROR: common.Verdict.VERDICT_RUNTIME_ERROR,
  COMPILATION_ERROR: common.Verdict.VERDICT_COMPILATION_ERROR,
  INTERNAL_ERROR: common.Verdict.VERDICT_INTERNAL_ERROR,
};

function toProtoSubmission(row: SubmissionRow, includeSourceCode: boolean): submissions.Submission {
  return {
    id: row.id,
    userId: row.userId,
    problemId: row.problemId,
    contestId: row.contestId ?? undefined,
    language:
      row.language === 'CPP17' ? common.Language.LANGUAGE_CPP17 : common.Language.LANGUAGE_PYTHON3,
    sourceCode: includeSourceCode ? row.sourceCode : '',
    verdict: VERDICT_TO_NEST[row.verdict] ?? common.Verdict.VERDICT_UNSPECIFIED,
    timeMs: row.timeMs,
    memoryKb: row.memoryKb,
    passedCases: row.passedCases,
    totalCases: row.totalCases,
    submittedAt: dateToTimestamp(row.submittedAt),
    judgedAt: row.judgedAt ? dateToTimestamp(row.judgedAt) : undefined,
  };
}

@Controller()
@submissions.SubmissionServiceControllerMethods()
export class SubmissionController implements submissions.SubmissionServiceController {
  constructor(
    @Inject('SubmissionsRepository')
    private readonly repo: SubmissionsRepository,
    @Inject('JwtVerifier')
    private readonly jwtVerifier: JwtVerifier,
    @Inject('ProblemsClient')
    private readonly problemsClient: ProblemsClient,
    @Inject('RankingClient')
    private readonly rankingClient: RankingClient,
    @Inject('Logger')
    private readonly logger: Logger,
    @Inject('Metrics')
    private readonly metrics: Metrics,
  ) {}

  private async authenticate(
    metadata?: Metadata,
  ): Promise<{ claims: TokenClaims; authHeader: string }> {
    try {
      const token = extractBearerToken(metadata);
      const claims = await this.jwtVerifier.verify(token);
      return { claims, authHeader: `Bearer ${token}` };
    } catch (err) {
      throw new RpcException({
        code: grpc.status.UNAUTHENTICATED,
        message: (err as Error).message || 'No autenticado',
      });
    }
  }

  /** Traduce un error de los clientes de problems / ranking a un RpcException. */
  private upstreamError(err: unknown, service: string, notFoundMessage: string): RpcException {
    switch (classifyUpstreamError(err)) {
      case 'not_found':
        return new RpcException({ code: grpc.status.NOT_FOUND, message: notFoundMessage });
      case 'unavailable':
        this.logger.warn({ err, service }, 'servicio dependiente no responde');
        return new RpcException({
          code: grpc.status.UNAVAILABLE,
          message: `El servicio ${service} no responde; intenta nuevamente más tarde`,
        });
      default:
        this.logger.error({ err, service }, 'error inesperado al consultar servicio dependiente');
        return new RpcException({
          code: grpc.status.INTERNAL,
          message: `Error al consultar el servicio ${service}`,
        });
    }
  }

  async createSubmission(
    request: submissions.CreateSubmissionRequest,
    metadata?: Metadata,
  ): Promise<submissions.CreateSubmissionResponse> {
    const started = performance.now();
    let codeName = 'ok';
    try {
      const { claims, authHeader } = await this.authenticate(metadata);

      // Mapear language de número/enum a LanguageName
      let languageName: LanguageName;
      if (
        request.language === common.Language.LANGUAGE_CPP17 ||
        (request.language as unknown as string) === 'CPP17' ||
        (request.language as unknown as string) === 'LANGUAGE_CPP17'
      ) {
        languageName = 'CPP17';
      } else if (
        request.language === common.Language.LANGUAGE_PYTHON3 ||
        (request.language as unknown as string) === 'PYTHON3' ||
        (request.language as unknown as string) === 'LANGUAGE_PYTHON3'
      ) {
        languageName = 'PYTHON3';
      } else {
        throw new RpcException({
          code: grpc.status.INVALID_ARGUMENT,
          message: 'Lenguaje no soportado (soportados: LANGUAGE_CPP17, LANGUAGE_PYTHON3)',
        });
      }

      // Validar campos
      const validated = createSubmissionSchema.safeParse({
        problemId: request.problemId,
        language: languageName,
        sourceCode: request.sourceCode,
        contestId: request.contestId || undefined,
      });

      if (!validated.success) {
        throw new RpcException({
          code: grpc.status.INVALID_ARGUMENT,
          message: validated.error.issues.map((i) => i.message).join('; '),
        });
      }

      // 1. Validar problema con el servicio problems
      let problem;
      try {
        problem = await this.problemsClient.getProblem(validated.data.problemId, authHeader);
      } catch (err) {
        throw this.upstreamError(
          err,
          'problems',
          `El problema ${validated.data.problemId} no existe o no está accesible`,
        );
      }

      // Los concursantes solo pueden enviar a problemas publicados
      if (!problem.published && claims.role === 'CONTESTANT') {
        throw new RpcException({
          code: grpc.status.FAILED_PRECONDITION,
          message: 'El problema no está publicado',
        });
      }

      // 2. Si viene contest_id, validar con ranking service
      if (validated.data.contestId) {
        let contest;
        try {
          contest = await this.rankingClient.getContest(validated.data.contestId, authHeader);
        } catch (err) {
          throw this.upstreamError(
            err,
            'ranking',
            `El contest ${validated.data.contestId} no existe`,
          );
        }

        // Validar que el contest está en curso
        if (contest.status !== ContestStatus.RUNNING) {
          throw new RpcException({
            code: grpc.status.FAILED_PRECONDITION,
            message: 'El contest no está en curso',
          });
        }

        // Validar que el problema pertenece al contest
        if (!contest.problemIds.includes(validated.data.problemId)) {
          throw new RpcException({
            code: grpc.status.FAILED_PRECONDITION,
            message: 'El problema no forma parte de este contest',
          });
        }
      }

      // 3. Crear submission + outbox en una transacción
      const row = await this.repo.createWithCreatedEvent({
        userId: claims.sub,
        problemId: validated.data.problemId,
        contestId: validated.data.contestId,
        language: validated.data.language,
        sourceCode: validated.data.sourceCode,
      });

      this.logger.info(
        { submissionId: row.id, userId: claims.sub, problemId: row.problemId },
        'submission creada',
      );

      return {
        submission: toProtoSubmission(row, true),
      };
    } catch (err) {
      codeName = err instanceof RpcException ? 'rpc_error' : 'internal';
      if (err instanceof RpcException) throw err;
      this.logger.error({ err }, 'error en createSubmission');
      throw new RpcException({
        code: grpc.status.INTERNAL,
        message: 'Error interno al registrar la submission',
      });
    } finally {
      const durationMs = performance.now() - started;
      this.metrics.rpcDuration.observe(
        { method: 'CreateSubmission', code: codeName },
        durationMs / 1000,
      );
    }
  }

  async getSubmission(
    request: submissions.GetSubmissionRequest,
    metadata?: Metadata,
  ): Promise<submissions.GetSubmissionResponse> {
    const started = performance.now();
    let codeName = 'ok';
    try {
      const { claims } = await this.authenticate(metadata);

      if (!isUuid(request.id)) {
        throw new RpcException({
          code: grpc.status.INVALID_ARGUMENT,
          message: 'id debe ser un UUID válido',
        });
      }

      const row = await this.repo.findById(request.id);
      if (!row) {
        throw new RpcException({
          code: grpc.status.NOT_FOUND,
          message: 'Submission no encontrada',
        });
      }

      // El código fuente solo es visible para el autor o ADMIN
      const showSourceCode = claims.sub === row.userId || claims.role === 'ADMIN';

      return {
        submission: toProtoSubmission(row, showSourceCode),
      };
    } catch (err) {
      codeName = err instanceof RpcException ? 'rpc_error' : 'internal';
      if (err instanceof RpcException) throw err;
      this.logger.error({ err }, 'error en getSubmission');
      throw new RpcException({
        code: grpc.status.INTERNAL,
        message: 'Error interno al obtener la submission',
      });
    } finally {
      const durationMs = performance.now() - started;
      this.metrics.rpcDuration.observe(
        { method: 'GetSubmission', code: codeName },
        durationMs / 1000,
      );
    }
  }

  async listSubmissions(
    request: submissions.ListSubmissionsRequest,
    metadata?: Metadata,
  ): Promise<submissions.ListSubmissionsResponse> {
    const started = performance.now();
    let codeName = 'ok';
    try {
      await this.authenticate(metadata);

      if (request.userId && !isUuid(request.userId)) {
        throw new RpcException({
          code: grpc.status.INVALID_ARGUMENT,
          message: 'user_id debe ser un UUID válido',
        });
      }
      if (request.problemId && !isUuid(request.problemId)) {
        throw new RpcException({
          code: grpc.status.INVALID_ARGUMENT,
          message: 'problem_id debe ser un UUID válido',
        });
      }
      if (request.contestId && !isUuid(request.contestId)) {
        throw new RpcException({
          code: grpc.status.INVALID_ARGUMENT,
          message: 'contest_id debe ser un UUID válido',
        });
      }

      const pageSize =
        request.pageSize > 0 ? Math.min(request.pageSize, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;

      const result = await this.repo.list({
        pageSize,
        pageToken: request.pageToken || undefined,
        userId: request.userId || undefined,
        problemId: request.problemId || undefined,
        contestId: request.contestId || undefined,
      });

      return {
        // En listados el sourceCode siempre va vacío
        submissions: result.submissions.map((s) => toProtoSubmission(s, false)),
        nextPageToken: result.nextPageToken ?? '',
      };
    } catch (err) {
      codeName = err instanceof RpcException ? 'rpc_error' : 'internal';
      if (err instanceof RpcException) throw err;
      this.logger.error({ err }, 'error en listSubmissions');
      throw new RpcException({
        code: grpc.status.INTERNAL,
        message: 'Error interno al listar submissions',
      });
    } finally {
      const durationMs = performance.now() - started;
      this.metrics.rpcDuration.observe(
        { method: 'ListSubmissions', code: codeName },
        durationMs / 1000,
      );
    }
  }
}
