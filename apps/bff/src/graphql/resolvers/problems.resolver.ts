import { Inject } from '@nestjs/common';
import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';
import type {
  CreateProblemInput,
  ExampleInput,
  Problem,
  ProblemFilter,
  ProblemPage,
  TestcaseUpload,
  UpdateProblemInput,
} from '../../gen/graphql.js';
import type { Backend } from '../../grpc/backend.js';
import { ErrorCode, gqlError, isNotFound } from '../../grpc/errors.js';
import { BACKEND } from '../../tokens.js';
import { optionalUser, requireRole } from '../context.js';
import type { GqlContext } from '../context.js';
import {
  difficultyToProto,
  mapProblem,
  mapProblemSummary,
  pageToken,
  requiredIso,
} from '../mappers.js';

const SETTER_ROLES = ['SETTER', 'ADMIN'] as const;

const toExamples = (examples: readonly ExampleInput[] | null | undefined) =>
  (examples ?? []).map((e) => ({
    input: e.input,
    output: e.output,
    explanation: e.explanation ?? '',
  }));

@Resolver()
export class ProblemsResolver {
  constructor(@Inject(BACKEND) private readonly backend: Backend) {}

  @Query('problems')
  async problems(
    @Args('filter') filter: ProblemFilter | null | undefined,
    @Args('pageSize') pageSize: number | null | undefined,
    @Args('pageToken') token: string | null | undefined,
    @Context() ctx: GqlContext,
  ): Promise<ProblemPage> {
    optionalUser(ctx);
    const res = await this.backend.problems.listProblems(
      {
        pageSize: pageSize ?? 0,
        pageToken: token ?? '',
        tags: filter?.tags ?? [],
        difficulty: difficultyToProto(filter?.difficulty),
      },
      ctx.meta,
    );
    return {
      items: (res.problems ?? []).map(mapProblemSummary),
      nextPageToken: pageToken(res.nextPageToken),
    };
  }

  @Query('problem')
  async problem(
    @Args('id') id: string | null | undefined,
    @Args('slug') slug: string | null | undefined,
    @Context() ctx: GqlContext,
  ): Promise<Problem | null> {
    optionalUser(ctx);
    if (Boolean(id) === Boolean(slug)) {
      throw gqlError(ErrorCode.BAD_USER_INPUT, 'Indica exactamente uno de `id` o `slug`.');
    }
    try {
      const res = await this.backend.problems.getProblem(id ? { id } : { slug: slug! }, ctx.meta);
      return res.problem ? mapProblem(res.problem) : null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  @Mutation('createProblem')
  async createProblem(
    @Args('input') input: CreateProblemInput,
    @Context() ctx: GqlContext,
  ): Promise<Problem> {
    requireRole(ctx, SETTER_ROLES);
    const res = await this.backend.problems.createProblem(
      {
        slug: input.slug ?? '',
        title: input.title,
        statement: input.statement,
        difficulty: difficultyToProto(input.difficulty),
        tags: input.tags ?? [],
        timeLimitMs: input.timeLimitMs ?? 0,
        memoryLimitMb: input.memoryLimitMb ?? 0,
        examples: toExamples(input.examples),
      },
      ctx.meta,
    );
    if (!res.problem) throw gqlError(ErrorCode.INTERNAL_SERVER_ERROR, 'Respuesta sin problema.');
    return mapProblem(res.problem);
  }

  /** Solo cambian los campos presentes y no nulos; `tags`/`examples` reemplazan la lista. */
  @Mutation('updateProblem')
  async updateProblem(
    @Args('id') id: string,
    @Args('input') input: UpdateProblemInput,
    @Context() ctx: GqlContext,
  ): Promise<Problem> {
    requireRole(ctx, SETTER_ROLES);
    const res = await this.backend.problems.updateProblem(
      {
        id,
        title: input.title ?? undefined,
        statement: input.statement ?? undefined,
        difficulty: difficultyToProto(input.difficulty),
        timeLimitMs: input.timeLimitMs ?? undefined,
        memoryLimitMb: input.memoryLimitMb ?? undefined,
        tags: input.tags ? { values: input.tags } : undefined,
        examples: input.examples ? { values: toExamples(input.examples) } : undefined,
        published: input.published ?? undefined,
      },
      ctx.meta,
    );
    if (!res.problem) throw gqlError(ErrorCode.INTERNAL_SERVER_ERROR, 'Respuesta sin problema.');
    return mapProblem(res.problem);
  }

  @Mutation('createTestcaseUploadUrl')
  async createTestcaseUploadUrl(
    @Args('problemId') problemId: string,
    @Args('ordinal') ordinal: number,
    @Context() ctx: GqlContext,
  ): Promise<TestcaseUpload> {
    requireRole(ctx, SETTER_ROLES);
    const res = await this.backend.problems.createTestcaseUploadUrl(
      { problemId, ordinal },
      ctx.meta,
    );
    return {
      testcaseId: res.testcaseId,
      ordinal,
      inputUploadUrl: res.inputUploadUrl,
      outputUploadUrl: res.outputUploadUrl,
      expiresAt: requiredIso(res.expiresAt),
    };
  }
}
