/** Veredictos finales que puede traer `submission.judged` (se guardan por nombre en la BD). */
export const VERDICT_NAMES = [
  'ACCEPTED',
  'WRONG_ANSWER',
  'TIME_LIMIT_EXCEEDED',
  'MEMORY_LIMIT_EXCEEDED',
  'RUNTIME_ERROR',
  'COMPILATION_ERROR',
  'INTERNAL_ERROR',
] as const;
export type VerdictName = (typeof VERDICT_NAMES)[number];

export interface Contest {
  id: string;
  title: string;
  description: string;
  startTime: Date;
  endTime: Date;
  /** En orden (A, B, C…). */
  problemIds: string[];
  createdBy: string;
  createdAt: Date;
}

export interface JudgedSubmission {
  submissionId: string;
  userId: string;
  problemId: string;
  contestId: string | null;
  verdict: VerdictName;
  submittedAt: Date;
}

/** Resultado de un usuario en un problema (sin `first_to_solve`, que depende del resto). */
export interface ProblemCell {
  problemId: string;
  solved: boolean;
  attempts: number;
  solvedAtMinute: number;
  penaltyMinutes: number;
}

export interface UserRow {
  userId: string;
  /** Vacío si aún no conocemos el username (se muestra el user_id). */
  username: string;
  solved: number;
  penaltyMinutes: number;
  /** En el orden de `Contest.problemIds`. */
  problems: ProblemCell[];
}

export interface RankedRow extends UserRow {
  rank: number;
}

/** Primer AC de un problema en la ventana del contest. */
export interface FirstSolver {
  problemId: string;
  userId: string;
  submissionId: string;
  submittedAt: Date;
}
