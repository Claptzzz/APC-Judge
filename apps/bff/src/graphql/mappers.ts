// Traducción entre los mensajes del proto (tipos ts-proto de @juez/contracts/nest) y los
// tipos del schema GraphQL (src/gen/graphql.ts). Reglas de la ficha:
// - Enums sin prefijo ni UNSPECIFIED (`VERDICT_ACCEPTED` → `ACCEPTED`); filtro null → UNSPECIFIED.
// - Timestamp → ISO 8601 UTC con milisegundos.
// - `0`/`""` sin veredicto final o sin valor → null.
import { common, problems, ranking } from '@juez/contracts/nest';
import type { submissions, Timestamp, users } from '@juez/contracts/nest';
import type {
  AuthPayload,
  Contest,
  ContestProblem,
  ContestStatus,
  Difficulty,
  Language,
  Problem,
  ProblemSummary,
  Role,
  Scoreboard,
  Submission,
  User,
  UserStats,
  Verdict,
} from '../gen/graphql.js';

// ---------------------------------------------------------------------------
// Modelos "padre": lo que devuelven las queries antes de resolver las relaciones.
// ---------------------------------------------------------------------------
export type SubmissionModel = Omit<Submission, 'user' | 'problem' | 'contest'>;
export type ContestProblemModel = Omit<ContestProblem, 'problem'>;
export type ContestModel = Omit<Contest, 'problems'> & { problems: ContestProblemModel[] };
export type AuthPayloadModel = AuthPayload;

/** Identidad de quien consulta, para decidir qué campos se ocultan. */
export interface Viewer {
  sub: string;
  role: Role;
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------
type NumericEnum = Record<string, string | number>;

function enumName<T extends string>(e: NumericEnum, prefix: string, value: number, fallback: T): T {
  const name = e[value];
  if (typeof name !== 'string' || !name.startsWith(prefix) || name.endsWith('UNSPECIFIED')) {
    return fallback;
  }
  return name.slice(prefix.length) as T;
}

function enumValue(e: NumericEnum, prefix: string, name: string | null | undefined): number {
  if (!name) return 0;
  const value = e[`${prefix}${name}`];
  return typeof value === 'number' ? value : 0;
}

export const FINAL_VERDICTS: ReadonlySet<Verdict> = new Set<Verdict>([
  'ACCEPTED',
  'WRONG_ANSWER',
  'TIME_LIMIT_EXCEEDED',
  'MEMORY_LIMIT_EXCEEDED',
  'RUNTIME_ERROR',
  'COMPILATION_ERROR',
  'INTERNAL_ERROR',
]);

export const verdictFromProto = (v: number): Verdict =>
  enumName(common.Verdict, 'VERDICT_', v, 'PENDING');
export const languageFromProto = (v: number): Language =>
  enumName(common.Language, 'LANGUAGE_', v, 'CPP17');
export const roleFromProto = (v: number): Role => enumName(common.Role, 'ROLE_', v, 'CONTESTANT');
export const difficultyFromProto = (v: number): Difficulty =>
  enumName(problems.Difficulty, 'DIFFICULTY_', v, 'EASY');
export const contestStatusFromProto = (v: number): ContestStatus =>
  enumName(ranking.ContestStatus, 'CONTEST_STATUS_', v, 'UPCOMING');

export const languageToProto = (v: Language): common.Language =>
  enumValue(common.Language, 'LANGUAGE_', v);
export const difficultyToProto = (v: Difficulty | null | undefined): problems.Difficulty =>
  enumValue(problems.Difficulty, 'DIFFICULTY_', v);
export const contestStatusToProto = (v: ContestStatus | null | undefined): ranking.ContestStatus =>
  enumValue(ranking.ContestStatus, 'CONTEST_STATUS_', v);

// ---------------------------------------------------------------------------
// Fechas
// ---------------------------------------------------------------------------
type TimestampLike = { seconds?: number | string | bigint | null; nanos?: number | null };

/** Timestamp → ISO 8601 UTC con ms; `null` si falta o es la época (valor por defecto). */
export function isoFromTimestamp(ts: TimestampLike | null | undefined): string | null {
  if (!ts) return null;
  const seconds = Number(ts.seconds ?? 0);
  const nanos = Number(ts.nanos ?? 0);
  if (!Number.isFinite(seconds) || (seconds === 0 && nanos === 0)) return null;
  return new Date(seconds * 1000 + Math.floor(nanos / 1_000_000)).toISOString();
}

/** Como `isoFromTimestamp`, para campos no nulos del schema. */
export function requiredIso(ts: TimestampLike | null | undefined): string {
  return isoFromTimestamp(ts) ?? new Date(0).toISOString();
}

export function timestampFromDate(date: Date): Timestamp {
  const ms = date.getTime();
  const seconds = Math.floor(ms / 1000);
  return { seconds, nanos: (ms - seconds * 1000) * 1_000_000 };
}

const orNull = (s: string | null | undefined): string | null => (s ? s : null);

// ---------------------------------------------------------------------------
// Usuarios
// ---------------------------------------------------------------------------
export function mapUser(u: users.User, viewer: Viewer | undefined): User {
  const canSeeEmail = viewer !== undefined && (viewer.sub === u.id || viewer.role === 'ADMIN');
  return {
    id: u.id,
    username: u.username,
    email: canSeeEmail ? orNull(u.email) : null,
    role: roleFromProto(u.role),
    createdAt: requiredIso(u.createdAt),
  };
}

export function mapLogin(res: users.LoginResponse): AuthPayload {
  if (!res.user) throw new Error('LoginResponse sin user');
  const user = mapUser(res.user, { sub: res.user.id, role: roleFromProto(res.user.role) });
  return {
    token: res.accessToken,
    expiresAt: requiredIso(res.expiresAt),
    user,
  };
}

// ---------------------------------------------------------------------------
// Problemas
// ---------------------------------------------------------------------------
export function mapProblem(p: problems.Problem): Problem {
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    statement: p.statement,
    difficulty: difficultyFromProto(p.difficulty),
    tags: p.tags ?? [],
    timeLimitMs: p.timeLimitMs,
    memoryLimitMb: p.memoryLimitMb,
    examples: (p.examples ?? []).map((e) => ({
      input: e.input,
      output: e.output,
      explanation: orNull(e.explanation),
    })),
    testcaseCount: p.testcaseCount,
    published: p.published,
    authorId: p.authorId,
    createdAt: requiredIso(p.createdAt),
    updatedAt: requiredIso(p.updatedAt),
  };
}

export function mapProblemSummary(p: problems.ProblemSummary | problems.Problem): ProblemSummary {
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    difficulty: difficultyFromProto(p.difficulty),
    tags: p.tags ?? [],
    published: p.published,
  };
}

// ---------------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------------
export function mapSubmission(
  s: submissions.Submission,
  viewer: Viewer | undefined,
  opts: { includeSource?: boolean } = {},
): SubmissionModel {
  const verdict = verdictFromProto(s.verdict);
  const final = FINAL_VERDICTS.has(verdict);
  const canSeeSource =
    opts.includeSource === true &&
    viewer !== undefined &&
    (viewer.sub === s.userId || viewer.role === 'ADMIN');
  return {
    id: s.id,
    userId: s.userId,
    problemId: s.problemId,
    contestId: orNull(s.contestId),
    language: languageFromProto(s.language),
    sourceCode: canSeeSource ? orNull(s.sourceCode) : null,
    verdict,
    timeMs: final ? s.timeMs : null,
    memoryKb: final ? s.memoryKb : null,
    passedCases: final ? s.passedCases : null,
    totalCases: final ? s.totalCases : null,
    submittedAt: requiredIso(s.submittedAt),
    judgedAt: final ? isoFromTimestamp(s.judgedAt) : null,
  };
}

// ---------------------------------------------------------------------------
// Contests, scoreboard y estadísticas
// ---------------------------------------------------------------------------
/** Letra del problema en el contest: 0 → A, 1 → B… */
export function contestLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

export function mapContest(c: ranking.Contest): ContestModel {
  return {
    id: c.id,
    title: c.title,
    description: c.description,
    startTime: requiredIso(c.startTime),
    endTime: requiredIso(c.endTime),
    status: contestStatusFromProto(c.status),
    problems: (c.problemIds ?? []).map((problemId, i) => ({
      letter: contestLetter(i),
      problemId,
    })),
    createdById: c.createdBy,
    createdAt: requiredIso(c.createdAt),
  };
}

export function mapScoreboard(res: ranking.GetScoreboardResponse, contestId: string): Scoreboard {
  return {
    contestId: res.contestId || contestId,
    items: (res.rows ?? []).map((row) => ({
      rank: row.rank,
      userId: row.userId,
      username: row.username || row.userId,
      solved: row.solved,
      penaltyMinutes: row.penaltyMinutes,
      problems: (row.problems ?? []).map((p, i) => ({
        letter: contestLetter(i),
        problemId: p.problemId,
        solved: p.solved,
        attempts: p.attempts,
        solvedAtMinute: p.solved ? p.solvedAtMinute : null,
        penaltyMinutes: p.solved ? p.penaltyMinutes : null,
        firstToSolve: p.firstToSolve,
      })),
    })),
    nextPageToken: orNull(res.nextPageToken),
    updatedAt: isoFromTimestamp(res.updatedAt),
  };
}

export function mapUserStats(res: ranking.GetUserStatsResponse): UserStats {
  return {
    userId: res.userId,
    username: res.username || res.userId,
    solvedCount: res.solvedCount,
    attemptedCount: res.attemptedCount,
    totalSubmissions: res.totalSubmissions,
    verdictCounts: (res.verdictCounts ?? []).map((v) => ({
      verdict: verdictFromProto(v.verdict),
      count: v.count,
    })),
    solvedProblemIds: res.solvedProblemIds ?? [],
  };
}

export const pageToken = orNull;
