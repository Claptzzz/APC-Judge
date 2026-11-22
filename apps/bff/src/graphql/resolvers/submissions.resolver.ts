import { Inject } from '@nestjs/common';
import { Args, Context, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import type { ProblemSummary, SubmissionFilter, SubmitInput, User } from '../../gen/graphql.js';
import type { Backend } from '../../grpc/backend.js';
import { ErrorCode, gqlError, isNotFound } from '../../grpc/errors.js';
import { BACKEND } from '../../tokens.js';
import { requireUser } from '../context.js';
import type { GqlContext } from '../context.js';
import {
  languageToProto,
  mapContest,
  mapProblemSummary,
  mapSubmission,
  mapUser,
  pageToken,
} from '../mappers.js';
import type { ContestModel, SubmissionModel } from '../mappers.js';

interface SubmissionPageModel {
  items: SubmissionModel[];
  nextPageToken: string | null;
}

@Resolver()
export class SubmissionsResolver {
  constructor(@Inject(BACKEND) private readonly backend: Backend) {}

  @Query('submission')
  async submission(
    @Args('id') id: string,
    @Context() ctx: GqlContext,
  ): Promise<SubmissionModel | null> {
    const viewer = requireUser(ctx);
    try {
      const res = await this.backend.submissions.getSubmission({ id }, ctx.meta);
      return res.submission ? mapSubmission(res.submission, viewer, { includeSource: true }) : null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  @Query('submissions')
  async submissions(
    @Args('filter') filter: SubmissionFilter | null | undefined,
    @Args('pageSize') pageSize: number | null | undefined,
    @Args('pageToken') token: string | null | undefined,
    @Context() ctx: GqlContext,
  ): Promise<SubmissionPageModel> {
    const viewer = requireUser(ctx);
    const res = await this.backend.submissions.listSubmissions(
      {
        pageSize: pageSize ?? 0,
        pageToken: token ?? '',
        userId: filter?.userId ?? undefined,
        problemId: filter?.problemId ?? undefined,
        contestId: filter?.contestId ?? undefined,
      },
      ctx.meta,
    );
    return {
      items: (res.submissions ?? []).map((s) => mapSubmission(s, viewer)),
      nextPageToken: pageToken(res.nextPageToken),
    };
  }

  @Mutation('submit')
  async submit(
    @Args('input') input: SubmitInput,
    @Context() ctx: GqlContext,
  ): Promise<SubmissionModel> {
    const viewer = requireUser(ctx);
    const res = await this.backend.submissions.createSubmission(
      {
        problemId: input.problemId,
        language: languageToProto(input.language),
        sourceCode: input.sourceCode,
        contestId: input.contestId ?? undefined,
      },
      ctx.meta,
    );
    if (!res.submission) {
      throw gqlError(ErrorCode.INTERNAL_SERVER_ERROR, 'Respuesta sin submission.');
    }
    return mapSubmission(res.submission, viewer, { includeSource: true });
  }
}

/**
 * Relaciones de `Submission`. Son nullable: si el servicio falla, el campo queda en `null`
 * (con un log) y el resto de la respuesta llega igual.
 */
@Resolver('Submission')
export class SubmissionFieldsResolver {
  @ResolveField('user')
  async user(@Parent() s: SubmissionModel, @Context() ctx: GqlContext): Promise<User | null> {
    try {
      const u = await ctx.loaders.users.load(s.userId);
      return u ? mapUser(u, ctx.user) : null;
    } catch (err) {
      ctx.logger.warn({ err, userId: s.userId }, 'Submission.user sin resolver; se devuelve null');
      return null;
    }
  }

  @ResolveField('problem')
  async problem(
    @Parent() s: SubmissionModel,
    @Context() ctx: GqlContext,
  ): Promise<ProblemSummary | null> {
    try {
      const p = await ctx.loaders.problems.load(s.problemId);
      return p ? mapProblemSummary(p) : null;
    } catch (err) {
      ctx.logger.warn(
        { err, problemId: s.problemId },
        'Submission.problem sin resolver; se devuelve null',
      );
      return null;
    }
  }

  @ResolveField('contest')
  async contest(
    @Parent() s: SubmissionModel,
    @Context() ctx: GqlContext,
  ): Promise<ContestModel | null> {
    if (!s.contestId) return null;
    try {
      const c = await ctx.loaders.contests.load(s.contestId);
      return c ? mapContest(c) : null;
    } catch (err) {
      ctx.logger.warn(
        { err, contestId: s.contestId },
        'Submission.contest sin resolver; se devuelve null',
      );
      return null;
    }
  }
}
