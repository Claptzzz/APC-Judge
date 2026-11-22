import { Inject } from '@nestjs/common';
import { Args, Context, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import type {
  ContestStatus,
  CreateContestInput,
  ProblemSummary,
  Scoreboard,
  UserStats,
} from '../../gen/graphql.js';
import type { Backend } from '../../grpc/backend.js';
import { ErrorCode, gqlError, isNotFound } from '../../grpc/errors.js';
import { BACKEND } from '../../tokens.js';
import { requireRole, requireUser } from '../context.js';
import type { GqlContext } from '../context.js';
import {
  contestStatusToProto,
  mapContest,
  mapProblemSummary,
  mapScoreboard,
  mapUserStats,
  pageToken,
  timestampFromDate,
} from '../mappers.js';
import type { ContestModel, ContestProblemModel } from '../mappers.js';

interface ContestPageModel {
  items: ContestModel[];
  nextPageToken: string | null;
}

@Resolver()
export class ContestsResolver {
  constructor(@Inject(BACKEND) private readonly backend: Backend) {}

  @Query('contest')
  async contest(@Args('id') id: string, @Context() ctx: GqlContext): Promise<ContestModel | null> {
    requireUser(ctx);
    try {
      const res = await this.backend.ranking.getContest({ id }, ctx.meta);
      return res.contest ? mapContest(res.contest) : null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  @Query('contests')
  async contests(
    @Args('status') status: ContestStatus | null | undefined,
    @Args('pageSize') pageSize: number | null | undefined,
    @Args('pageToken') token: string | null | undefined,
    @Context() ctx: GqlContext,
  ): Promise<ContestPageModel> {
    requireUser(ctx);
    const res = await this.backend.ranking.listContests(
      { pageSize: pageSize ?? 0, pageToken: token ?? '', status: contestStatusToProto(status) },
      ctx.meta,
    );
    return {
      items: (res.contests ?? []).map(mapContest),
      nextPageToken: pageToken(res.nextPageToken),
    };
  }

  @Query('scoreboard')
  async scoreboard(
    @Args('contestId') contestId: string,
    @Args('pageSize') pageSize: number | null | undefined,
    @Args('pageToken') token: string | null | undefined,
    @Context() ctx: GqlContext,
  ): Promise<Scoreboard> {
    requireUser(ctx);
    const res = await this.backend.ranking.getScoreboard(
      { contestId, pageSize: pageSize ?? 0, pageToken: token ?? '' },
      ctx.meta,
    );
    return mapScoreboard(res, contestId);
  }

  @Query('userStats')
  async userStats(
    @Args('userId') userId: string | null | undefined,
    @Context() ctx: GqlContext,
  ): Promise<UserStats> {
    requireUser(ctx);
    const res = await this.backend.ranking.getUserStats({ userId: userId ?? '' }, ctx.meta);
    return mapUserStats(res);
  }

  @Mutation('createContest')
  async createContest(
    @Args('input') input: CreateContestInput,
    @Context() ctx: GqlContext,
  ): Promise<ContestModel> {
    requireRole(ctx, ['SETTER', 'ADMIN']);
    const res = await this.backend.ranking.createContest(
      {
        title: input.title,
        description: input.description ?? '',
        startTime: timestampFromDate(input.startTime),
        endTime: timestampFromDate(input.endTime),
        problemIds: input.problemIds,
      },
      ctx.meta,
    );
    if (!res.contest) throw gqlError(ErrorCode.INTERNAL_SERVER_ERROR, 'Respuesta sin contest.');
    return mapContest(res.contest);
  }
}

/** `ContestProblem.problem`: nullable; si problems falla o no puede verse, queda en null. */
@Resolver('ContestProblem')
export class ContestProblemFieldsResolver {
  @ResolveField('problem')
  async problem(
    @Parent() cp: ContestProblemModel,
    @Context() ctx: GqlContext,
  ): Promise<ProblemSummary | null> {
    try {
      const p = await ctx.loaders.problems.load(cp.problemId);
      return p ? mapProblemSummary(p) : null;
    } catch (err) {
      ctx.logger.warn(
        { err, problemId: cp.problemId },
        'ContestProblem.problem sin resolver; se devuelve null',
      );
      return null;
    }
  }
}
