import type {
  Contest,
  FirstSolver,
  JudgedSubmission,
  ProblemCell,
  RankedRow,
  UserRow,
  VerdictName,
} from './types.js';

export const PENALTY_PER_REJECTION = 20;
/** Score en Redis = resueltos × 10^7 − penalización. */
export const SCORE_SOLVED_WEIGHT = 10_000_000;
const MS_PER_MINUTE = 60_000;

/** CE e IE no son culpa de la solución: no cuentan como intento rechazado. */
const NOT_COUNTED: ReadonlySet<VerdictName> = new Set(['COMPILATION_ERROR', 'INTERNAL_ERROR']);

export function countsAsAttempt(verdict: VerdictName): boolean {
  return !NOT_COUNTED.has(verdict);
}

/** La submission cae en [start, end) del contest. */
export function inContestWindow(contest: Pick<Contest, 'startTime' | 'endTime'>, at: Date) {
  const t = at.getTime();
  return t >= contest.startTime.getTime() && t < contest.endTime.getTime();
}

/** Orden cronológico por `submitted_at` (no por llegada); desempate por submission_id. */
function chronological(a: JudgedSubmission, b: JudgedSubmission): number {
  const d = a.submittedAt.getTime() - b.submittedAt.getTime();
  if (d !== 0) return d;
  return a.submissionId < b.submissionId ? -1 : a.submissionId > b.submissionId ? 1 : 0;
}

/** Submissions que cuentan para el scoreboard: del contest, en la ventana y de sus problemas. */
export function relevantSubmissions(
  contest: Contest,
  subs: readonly JudgedSubmission[],
): JudgedSubmission[] {
  const problems = new Set(contest.problemIds);
  return subs.filter(
    (s) =>
      s.contestId === contest.id &&
      problems.has(s.problemId) &&
      inContestWindow(contest, s.submittedAt),
  );
}

/** Celda ICPC de un problema a partir de las submissions (de un usuario) a ese problema. */
export function computeProblemCell(
  contest: Contest,
  problemId: string,
  subs: readonly JudgedSubmission[],
): ProblemCell {
  const ordered = subs.filter((s) => s.problemId === problemId).sort(chronological);
  const firstAc = ordered.find((s) => s.verdict === 'ACCEPTED');
  if (!firstAc) {
    return {
      problemId,
      solved: false,
      attempts: ordered.filter((s) => countsAsAttempt(s.verdict)).length,
      solvedAtMinute: 0,
      penaltyMinutes: 0,
    };
  }
  const acAt = firstAc.submittedAt.getTime();
  // Rechazos con submitted_at estrictamente anterior al primer AC.
  const rejectedBefore = ordered.filter(
    (s) => s.verdict !== 'ACCEPTED' && countsAsAttempt(s.verdict) && s.submittedAt.getTime() < acAt,
  ).length;
  const solvedAtMinute = Math.floor((acAt - contest.startTime.getTime()) / MS_PER_MINUTE);
  return {
    problemId,
    solved: true,
    attempts: rejectedBefore + 1,
    solvedAtMinute,
    penaltyMinutes: solvedAtMinute + PENALTY_PER_REJECTION * rejectedBefore,
  };
}

/**
 * Fila del scoreboard de un usuario. `undefined` si no tiene ninguna submission que cuente
 * (así un usuario con envíos solo fuera de la ventana no aparece).
 */
export function computeUserRow(
  contest: Contest,
  userId: string,
  username: string,
  subs: readonly JudgedSubmission[],
): UserRow | undefined {
  const mine = relevantSubmissions(contest, subs).filter((s) => s.userId === userId);
  if (mine.length === 0) return undefined;
  const problems = contest.problemIds.map((p) => computeProblemCell(contest, p, mine));
  const solvedCells = problems.filter((c) => c.solved);
  return {
    userId,
    username,
    solved: solvedCells.length,
    penaltyMinutes: solvedCells.reduce((acc, c) => acc + c.penaltyMinutes, 0),
    problems,
  };
}

/** Filas de todos los participantes del contest (sin orden). */
export function computeContestRows(
  contest: Contest,
  subs: readonly JudgedSubmission[],
  usernames: ReadonlyMap<string, string>,
): UserRow[] {
  const byUser = new Map<string, JudgedSubmission[]>();
  for (const s of relevantSubmissions(contest, subs)) {
    const list = byUser.get(s.userId) ?? [];
    list.push(s);
    byUser.set(s.userId, list);
  }
  return [...byUser.entries()].flatMap(([userId, list]) => {
    const row = computeUserRow(contest, userId, usernames.get(userId) ?? '', list);
    return row ? [row] : [];
  });
}

/** Primer AC (menor submitted_at) de cada problema del contest. */
export function computeFirstSolvers(
  contest: Contest,
  subs: readonly JudgedSubmission[],
): FirstSolver[] {
  const accepted = relevantSubmissions(contest, subs)
    .filter((s) => s.verdict === 'ACCEPTED')
    .sort(chronological);
  const first = new Map<string, FirstSolver>();
  for (const s of accepted) {
    if (!first.has(s.problemId)) {
      first.set(s.problemId, {
        problemId: s.problemId,
        userId: s.userId,
        submissionId: s.submissionId,
        submittedAt: s.submittedAt,
      });
    }
  }
  return contest.problemIds.flatMap((p) => {
    const f = first.get(p);
    return f ? [f] : [];
  });
}

export function scoreOf(row: Pick<UserRow, 'solved' | 'penaltyMinutes'>): number {
  return row.solved * SCORE_SOLVED_WEIGHT - row.penaltyMinutes;
}

/**
 * Ordena como el sorted set de Redis (ZREVRANGE): score desc y, a igual score, user_id desc.
 * Así el scoreboard calculado desde Postgres coincide con el de la proyección.
 */
export function compareRows(a: UserRow, b: UserRow): number {
  const d = scoreOf(b) - scoreOf(a);
  if (d !== 0) return d;
  return a.userId < b.userId ? 1 : a.userId > b.userId ? -1 : 0;
}

/** Más resueltos, luego menor penalización. Empates en (solved, penalty) comparten rank. */
export function rankRows(rows: readonly UserRow[]): RankedRow[] {
  const sorted = [...rows].sort(compareRows);
  const ranked: RankedRow[] = [];
  sorted.forEach((row, i) => {
    const prev = ranked[i - 1];
    const rank = prev && scoreOf(prev) === scoreOf(row) ? prev.rank : i + 1;
    ranked.push({ ...row, rank });
  });
  return ranked;
}
