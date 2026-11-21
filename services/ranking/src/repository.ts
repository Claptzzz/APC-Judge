import { and, asc, desc, eq, gte, inArray, lt, lte, gt, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { Db } from './db/client.js';
import {
  contestProblems,
  contests,
  judgedSubmissions,
  processedEvents,
  usernames,
} from './db/schema.js';
import type { ContestStatusName } from './domain/contest.js';
import { problemLetter } from './domain/contest.js';
import type { Contest, JudgedSubmission, VerdictName } from './domain/types.js';

export interface NewContest {
  title: string;
  description: string;
  startTime: Date;
  endTime: Date;
  problemIds: string[];
  createdBy: string;
}

export interface ContestCursor {
  startTime: Date;
  id: string;
}

export interface ListContestsQuery {
  limit: number;
  after?: ContestCursor;
  status?: ContestStatusName;
  now: Date;
}

export interface UserRegisteredData {
  eventId: string;
  userId: string;
  username: string;
}

export interface SubmissionJudgedData {
  eventId: string;
  submissionId: string;
  userId: string;
  problemId: string;
  contestId: string | null;
  verdict: VerdictName;
  submittedAt: Date;
  judgedAt: Date;
}

export interface UserStatsData {
  username: string | undefined;
  totalSubmissions: number;
  verdictCounts: { verdict: VerdictName; count: number }[];
  solvedProblemIds: string[];
  attemptedCount: number;
}

export interface SubmissionFilter {
  userId?: string;
  acceptedOnly?: boolean;
}

/** Acceso a Postgres (fuente de verdad). */
export interface RankingRepository {
  /**
   * Aplica `user.registered` en una transacción: registra el event_id en `processed_events`
   * (ON CONFLICT DO NOTHING) y guarda el username. `false` si el evento ya se había procesado.
   */
  applyUserRegistered(data: UserRegisteredData): Promise<boolean>;
  /** Igual que `applyUserRegistered`, para `submission.judged`. */
  applySubmissionJudged(data: SubmissionJudgedData): Promise<boolean>;

  createContest(input: NewContest): Promise<Contest>;
  findContest(id: string): Promise<Contest | undefined>;
  listContests(query: ListContestsQuery): Promise<Contest[]>;
  listContestIds(): Promise<string[]>;
  /** Contests existentes en los que el usuario tiene submissions. */
  contestsOfUser(userId: string): Promise<string[]>;

  /** Submissions del contest dentro de su ventana [start, end). */
  contestSubmissions(contest: Contest, filter?: SubmissionFilter): Promise<JudgedSubmission[]>;
  usernames(userIds: readonly string[]): Promise<Map<string, string>>;
  userStats(userId: string): Promise<UserStatsData>;
}

/** Transacción de drizzle (mismo query builder que Db). */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export class DrizzleRankingRepository implements RankingRepository {
  constructor(private readonly db: Db) {}

  /** Inserta el event_id; `false` si ya estaba (evento duplicado). */
  private async markProcessed(tx: Tx, eventId: string, topic: string): Promise<boolean> {
    const inserted = await tx
      .insert(processedEvents)
      .values({ eventId, topic })
      .onConflictDoNothing()
      .returning({ eventId: processedEvents.eventId });
    return inserted.length > 0;
  }

  applyUserRegistered(data: UserRegisteredData): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      if (!(await this.markProcessed(tx, data.eventId, 'user.registered'))) return false;
      await tx
        .insert(usernames)
        .values({ userId: data.userId, username: data.username })
        .onConflictDoUpdate({
          target: usernames.userId,
          set: { username: data.username, updatedAt: sql`now()` },
        });
      return true;
    });
  }

  applySubmissionJudged(data: SubmissionJudgedData): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      if (!(await this.markProcessed(tx, data.eventId, 'submission.judged'))) return false;
      await tx
        .insert(judgedSubmissions)
        .values({
          submissionId: data.submissionId,
          userId: data.userId,
          problemId: data.problemId,
          contestId: data.contestId,
          verdict: data.verdict,
          submittedAt: data.submittedAt,
          judgedAt: data.judgedAt,
          eventId: data.eventId,
        })
        // Re-juzgamiento (otro event_id para la misma submission): gana el más reciente.
        .onConflictDoUpdate({
          target: judgedSubmissions.submissionId,
          set: {
            verdict: sql`excluded.verdict`,
            judgedAt: sql`excluded.judged_at`,
            eventId: sql`excluded.event_id`,
          },
          setWhere: sql`${judgedSubmissions.judgedAt} <= excluded.judged_at`,
        });
      return true;
    });
  }

  createContest(input: NewContest): Promise<Contest> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(contests)
        .values({
          title: input.title,
          description: input.description,
          startTime: input.startTime,
          endTime: input.endTime,
          createdBy: input.createdBy,
        })
        .returning();
      if (!row) throw new Error('INSERT de contest sin filas');
      await tx.insert(contestProblems).values(
        input.problemIds.map((problemId, position) => ({
          contestId: row.id,
          problemId,
          position,
          letter: problemLetter(position),
        })),
      );
      return { ...row, problemIds: [...input.problemIds] };
    });
  }

  private async withProblems(rows: (typeof contests.$inferSelect)[]): Promise<Contest[]> {
    if (rows.length === 0) return [];
    const problems = await this.db
      .select()
      .from(contestProblems)
      .where(
        inArray(
          contestProblems.contestId,
          rows.map((r) => r.id),
        ),
      )
      .orderBy(asc(contestProblems.contestId), asc(contestProblems.position));
    const byContest = new Map<string, string[]>();
    for (const p of problems) {
      const list = byContest.get(p.contestId) ?? [];
      list.push(p.problemId);
      byContest.set(p.contestId, list);
    }
    return rows.map((r) => ({ ...r, problemIds: byContest.get(r.id) ?? [] }));
  }

  async findContest(id: string): Promise<Contest | undefined> {
    const rows = await this.db.select().from(contests).where(eq(contests.id, id)).limit(1);
    const [contest] = await this.withProblems(rows);
    return contest;
  }

  async listContests(q: ListContestsQuery): Promise<Contest[]> {
    const conditions: SQL[] = [];
    if (q.status === 'UPCOMING') conditions.push(gt(contests.startTime, q.now));
    if (q.status === 'RUNNING') {
      conditions.push(lte(contests.startTime, q.now), gt(contests.endTime, q.now));
    }
    if (q.status === 'FINISHED') conditions.push(lte(contests.endTime, q.now));
    if (q.after) {
      conditions.push(
        // En un sql`` crudo drizzle no serializa Date: se pasa ISO con cast explícito.
        sql`(${contests.startTime}, ${contests.id}) < (${q.after.startTime.toISOString()}::timestamptz, ${q.after.id}::uuid)`,
      );
    }
    const rows = await this.db
      .select()
      .from(contests)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(contests.startTime), desc(contests.id))
      .limit(q.limit);
    return this.withProblems(rows);
  }

  async listContestIds(): Promise<string[]> {
    const rows = await this.db.select({ id: contests.id }).from(contests);
    return rows.map((r) => r.id);
  }

  async contestsOfUser(userId: string): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ id: contests.id })
      .from(judgedSubmissions)
      .innerJoin(contests, eq(contests.id, judgedSubmissions.contestId))
      .where(eq(judgedSubmissions.userId, userId));
    return rows.map((r) => r.id);
  }

  async contestSubmissions(
    contest: Contest,
    filter: SubmissionFilter = {},
  ): Promise<JudgedSubmission[]> {
    const conditions: SQL[] = [
      eq(judgedSubmissions.contestId, contest.id),
      gte(judgedSubmissions.submittedAt, contest.startTime),
      lt(judgedSubmissions.submittedAt, contest.endTime),
    ];
    if (filter.userId) conditions.push(eq(judgedSubmissions.userId, filter.userId));
    if (filter.acceptedOnly) conditions.push(eq(judgedSubmissions.verdict, 'ACCEPTED'));
    const rows = await this.db
      .select({
        submissionId: judgedSubmissions.submissionId,
        userId: judgedSubmissions.userId,
        problemId: judgedSubmissions.problemId,
        contestId: judgedSubmissions.contestId,
        verdict: judgedSubmissions.verdict,
        submittedAt: judgedSubmissions.submittedAt,
      })
      .from(judgedSubmissions)
      .where(and(...conditions));
    return rows.map((r) => ({ ...r, verdict: r.verdict as VerdictName }));
  }

  async usernames(userIds: readonly string[]): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.db
      .select({ userId: usernames.userId, username: usernames.username })
      .from(usernames)
      .where(inArray(usernames.userId, [...userIds]));
    return new Map(rows.map((r) => [r.userId, r.username]));
  }

  async userStats(userId: string): Promise<UserStatsData> {
    const [verdicts, problems, names] = await Promise.all([
      this.db
        .select({ verdict: judgedSubmissions.verdict, count: sql<number>`count(*)::int` })
        .from(judgedSubmissions)
        .where(eq(judgedSubmissions.userId, userId))
        .groupBy(judgedSubmissions.verdict),
      this.db
        .select({
          problemId: judgedSubmissions.problemId,
          solved: sql<boolean>`bool_or(${judgedSubmissions.verdict} = 'ACCEPTED')`,
        })
        .from(judgedSubmissions)
        .where(eq(judgedSubmissions.userId, userId))
        .groupBy(judgedSubmissions.problemId)
        .orderBy(asc(judgedSubmissions.problemId)),
      this.usernames([userId]),
    ]);
    return {
      username: names.get(userId),
      totalSubmissions: verdicts.reduce((acc, v) => acc + v.count, 0),
      verdictCounts: verdicts.map((v) => ({ verdict: v.verdict as VerdictName, count: v.count })),
      solvedProblemIds: problems.filter((p) => p.solved).map((p) => p.problemId),
      attemptedCount: problems.length,
    };
  }
}
