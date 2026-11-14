import type { MessageInitShape } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { HandlerContext, ServiceImpl } from '@connectrpc/connect';
import { AUTH_METADATA_KEY } from '@juez/contracts';
import type { ProblemSchema, ProblemService, ProblemSummarySchema } from '@juez/contracts/es';
import { bearerToken, type JwtVerifier, type Principal } from '../auth/jwt.js';
import type { ProblemRecord } from '../db/problems-repository.js';
import type { ProblemCatalog, ProblemView } from '../domain/problem-catalog.js';
import { difficultyFromDb } from '../domain/validation.js';

export function toProblemMessage({
  problem: p,
  testcaseCount,
}: ProblemView): MessageInitShape<typeof ProblemSchema> {
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    statement: p.statement,
    difficulty: difficultyFromDb(p.difficulty),
    tags: p.tags,
    timeLimitMs: p.timeLimitMs,
    memoryLimitMb: p.memoryLimitMb,
    examples: p.examples,
    testcaseCount,
    published: p.published,
    authorId: p.authorId,
    createdAt: timestampFromDate(p.createdAt),
    updatedAt: timestampFromDate(p.updatedAt),
  };
}

export function toSummaryMessage(p: ProblemRecord): MessageInitShape<typeof ProblemSummarySchema> {
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    difficulty: difficultyFromDb(p.difficulty),
    tags: p.tags,
    published: p.published,
  };
}

/**
 * Identidad del llamador. Sin header `authorization` → anónimo (lecturas públicas, solo
 * problemas publicados). Con header, el token debe ser válido o la RPC falla.
 */
async function principalOf(
  ctx: HandlerContext,
  verifier: JwtVerifier,
): Promise<Principal | undefined> {
  const token = bearerToken(ctx.requestHeader.get(AUTH_METADATA_KEY));
  return token === undefined ? undefined : verifier.verify(token);
}

export function createProblemServiceImpl(
  catalog: ProblemCatalog,
  verifier: JwtVerifier,
): ServiceImpl<typeof ProblemService> {
  return {
    async listProblems(req, ctx) {
      const { problems, nextPageToken } = await catalog.list(req, await principalOf(ctx, verifier));
      return { problems: problems.map(toSummaryMessage), nextPageToken };
    },

    async getProblem(req, ctx) {
      return {
        problem: toProblemMessage(await catalog.get(req, await principalOf(ctx, verifier))),
      };
    },

    async createProblem(req, ctx) {
      return {
        problem: toProblemMessage(await catalog.create(req, await principalOf(ctx, verifier))),
      };
    },

    async updateProblem(req, ctx) {
      return {
        problem: toProblemMessage(await catalog.update(req, await principalOf(ctx, verifier))),
      };
    },

    async createTestcaseUploadUrl(req, ctx) {
      const urls = await catalog.createTestcaseUploadUrl(req, await principalOf(ctx, verifier));
      return {
        testcaseId: urls.testcaseId,
        inputUploadUrl: urls.inputUrl,
        outputUploadUrl: urls.outputUrl,
        expiresAt: timestampFromDate(urls.expiresAt),
      };
    },

    // Interna (judge): no exige JWT; se restringe por red (NetworkPolicy en k8s).
    async getJudgeSpec(req) {
      const spec = await catalog.judgeSpec(req.problemId);
      return {
        problemId: spec.problem.id,
        timeLimitMs: spec.problem.timeLimitMs,
        memoryLimitMb: spec.problem.memoryLimitMb,
        testcases: spec.testcases,
        urlsExpireAt: timestampFromDate(spec.urlsExpireAt),
      };
    },
  };
}
