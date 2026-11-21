import type { MessageInitShape } from '@bufbuild/protobuf';
import { timestampDate, timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError } from '@connectrpc/connect';
import type { HandlerContext, ServiceImpl } from '@connectrpc/connect';
import { AUTH_METADATA_KEY } from '@juez/contracts';
import { ContestStatus } from '@juez/contracts/es';
import type { ContestSchema, RankingService, ScoreboardRowSchema } from '@juez/contracts/es';
import type { JwtVerifier, Principal } from '../auth/jwt.js';
import { bearerToken } from '../auth/jwt.js';
import type { ProblemsGateway } from '../clients/problems.js';
import type { ContestStatusName } from '../domain/contest.js';
import { contestStatus, isUuid, MAX_CONTEST_PROBLEMS } from '../domain/contest.js';
import type { Contest, RankedRow } from '../domain/types.js';
import { VERDICT_TO_PROTO } from '../domain/verdicts.js';
import type { ScoreboardProjector } from '../projection/projector.js';
import type { RankingRepository } from '../repository.js';
import { kRequestId } from './interceptors.js';
import {
  decodeContestCursor,
  decodeOffset,
  encodeContestCursor,
  encodeOffset,
  pageSize,
} from './pagination.js';

export const MAX_TITLE_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 20_000;
export const CONTESTS_PAGE = { def: 20, max: 100 };
export const SCOREBOARD_PAGE = { def: 50, max: 200 };

export interface RankingServiceDeps {
  repo: RankingRepository;
  projector: ScoreboardProjector;
  problems: ProblemsGateway;
  verifier: JwtVerifier;
  now?: () => Date;
}

const STATUS_TO_PROTO: Record<ContestStatusName, ContestStatus> = {
  UPCOMING: ContestStatus.UPCOMING,
  RUNNING: ContestStatus.RUNNING,
  FINISHED: ContestStatus.FINISHED,
};

const PROTO_TO_STATUS: Partial<Record<ContestStatus, ContestStatusName>> = {
  [ContestStatus.UPCOMING]: 'UPCOMING',
  [ContestStatus.RUNNING]: 'RUNNING',
  [ContestStatus.FINISHED]: 'FINISHED',
};

export function toProtoContest(c: Contest, now: Date): MessageInitShape<typeof ContestSchema> {
  return {
    id: c.id,
    title: c.title,
    description: c.description,
    startTime: timestampFromDate(c.startTime),
    endTime: timestampFromDate(c.endTime),
    problemIds: c.problemIds,
    status: STATUS_TO_PROTO[contestStatus(c, now)],
    createdBy: c.createdBy,
    createdAt: timestampFromDate(c.createdAt),
  };
}

export function toProtoRow(
  row: RankedRow,
  contest: Contest,
  firstSolvers: ReadonlyMap<string, string>,
): MessageInitShape<typeof ScoreboardRowSchema> {
  const cells = new Map(row.problems.map((p) => [p.problemId, p]));
  return {
    rank: row.rank,
    userId: row.userId,
    // Sin username conocido (aún no llegó user.registered) se muestra el user_id.
    username: row.username || row.userId,
    solved: row.solved,
    penaltyMinutes: row.penaltyMinutes,
    problems: contest.problemIds.map((problemId) => {
      const cell = cells.get(problemId);
      return {
        problemId,
        solved: cell?.solved ?? false,
        attempts: cell?.attempts ?? 0,
        solvedAtMinute: cell?.solvedAtMinute ?? 0,
        penaltyMinutes: cell?.penaltyMinutes ?? 0,
        firstToSolve: (cell?.solved ?? false) && firstSolvers.get(problemId) === row.userId,
      };
    }),
  };
}

function requireUuid(value: string, field: string): string {
  if (!isUuid(value)) throw new ConnectError(`${field} debe ser un UUID`, Code.InvalidArgument);
  return value.toLowerCase();
}

export function createRankingServiceImpl(
  deps: RankingServiceDeps,
): ServiceImpl<typeof RankingService> {
  const now = deps.now ?? (() => new Date());

  const authenticate = (ctx: HandlerContext): Promise<Principal> =>
    deps.verifier.verify(bearerToken(ctx.requestHeader.get(AUTH_METADATA_KEY)));

  const loadContest = async (id: string): Promise<Contest> => {
    const contest = await deps.repo.findContest(requireUuid(id, 'contest_id'));
    if (!contest) throw new ConnectError('contest no encontrado', Code.NotFound);
    return contest;
  };

  return {
    async createContest(req, ctx) {
      const principal = await authenticate(ctx);
      if (principal.role !== 'SETTER' && principal.role !== 'ADMIN') {
        throw new ConnectError('crear contests requiere rol SETTER o ADMIN', Code.PermissionDenied);
      }

      const title = req.title.trim();
      if (!title || title.length > MAX_TITLE_LENGTH) {
        throw new ConnectError(
          `title es obligatorio (máximo ${MAX_TITLE_LENGTH} caracteres)`,
          Code.InvalidArgument,
        );
      }
      if (req.description.length > MAX_DESCRIPTION_LENGTH) {
        throw new ConnectError(
          `description admite como máximo ${MAX_DESCRIPTION_LENGTH} caracteres`,
          Code.InvalidArgument,
        );
      }
      if (!req.startTime || !req.endTime) {
        throw new ConnectError('start_time y end_time son obligatorios', Code.InvalidArgument);
      }
      const startTime = timestampDate(req.startTime);
      const endTime = timestampDate(req.endTime);
      if (!(startTime.getTime() < endTime.getTime())) {
        throw new ConnectError('start_time debe ser anterior a end_time', Code.InvalidArgument);
      }
      if (req.problemIds.length === 0 || req.problemIds.length > MAX_CONTEST_PROBLEMS) {
        throw new ConnectError(
          `problem_ids debe tener entre 1 y ${MAX_CONTEST_PROBLEMS} problemas`,
          Code.InvalidArgument,
        );
      }
      const problemIds = req.problemIds.map((id) => requireUuid(id, 'problem_ids'));
      if (new Set(problemIds).size !== problemIds.length) {
        throw new ConnectError('problem_ids tiene problemas repetidos', Code.InvalidArgument);
      }

      await deps.problems.assertProblemsExist(problemIds, {
        authorization: ctx.requestHeader.get(AUTH_METADATA_KEY),
        requestId: ctx.values.get(kRequestId),
      });

      const contest = await deps.repo.createContest({
        title,
        description: req.description,
        startTime,
        endTime,
        problemIds,
        createdBy: principal.userId,
      });
      return { contest: toProtoContest(contest, now()) };
    },

    async getContest(req, ctx) {
      await authenticate(ctx);
      return { contest: toProtoContest(await loadContest(req.id), now()) };
    },

    async listContests(req, ctx) {
      await authenticate(ctx);
      const limit = pageSize(req.pageSize, CONTESTS_PAGE.def, CONTESTS_PAGE.max);
      const after = decodeContestCursor(req.pageToken);
      const at = now();
      const status =
        req.status === ContestStatus.UNSPECIFIED ? undefined : PROTO_TO_STATUS[req.status];
      if (req.status !== ContestStatus.UNSPECIFIED && !status) {
        throw new ConnectError('status desconocido', Code.InvalidArgument);
      }
      const rows = await deps.repo.listContests({ limit: limit + 1, after, status, now: at });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        contests: page.map((c) => toProtoContest(c, at)),
        nextPageToken: rows.length > limit && last ? encodeContestCursor(last) : '',
      };
    },

    async getScoreboard(req, ctx) {
      await authenticate(ctx);
      const contest = await loadContest(req.contestId);
      const limit = pageSize(req.pageSize, SCOREBOARD_PAGE.def, SCOREBOARD_PAGE.max);
      const offset = decodeOffset(req.pageToken);
      const page = await deps.projector.scoreboard(contest, offset, limit);
      return {
        contestId: contest.id,
        rows: page.rows.map((r) => toProtoRow(r, contest, page.firstSolvers)),
        nextPageToken: offset + limit < page.total ? encodeOffset(offset + limit) : '',
        updatedAt: timestampFromDate(page.updatedAt ?? now()),
      };
    },

    async getUserStats(req, ctx) {
      const principal = await authenticate(ctx);
      const userId = req.userId ? requireUuid(req.userId, 'user_id') : principal.userId;
      const stats = await deps.repo.userStats(userId);
      return {
        userId,
        username: stats.username ?? userId,
        solvedCount: stats.solvedProblemIds.length,
        attemptedCount: stats.attemptedCount,
        totalSubmissions: stats.totalSubmissions,
        verdictCounts: stats.verdictCounts
          .map((v) => ({ verdict: VERDICT_TO_PROTO[v.verdict], count: v.count }))
          .sort((a, b) => a.verdict - b.verdict),
        solvedProblemIds: stats.solvedProblemIds,
      };
    },
  };
}
