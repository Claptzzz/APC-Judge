import type { Contest } from './types.js';

export type ContestStatusName = 'UPCOMING' | 'RUNNING' | 'FINISHED';

/** Máximo de problemas por contest: una letra por problema (A–Z). */
export const MAX_CONTEST_PROBLEMS = 26;

/** Estado calculado con la hora actual: programado, en curso o terminado. */
export function contestStatus(
  contest: Pick<Contest, 'startTime' | 'endTime'>,
  now: Date,
): ContestStatusName {
  const t = now.getTime();
  if (t < contest.startTime.getTime()) return 'UPCOMING';
  if (t < contest.endTime.getTime()) return 'RUNNING';
  return 'FINISHED';
}

/** 0 -> 'A', 1 -> 'B', … 25 -> 'Z'. */
export function problemLetter(position: number): string {
  if (!Number.isInteger(position) || position < 0 || position >= MAX_CONTEST_PROBLEMS) {
    throw new RangeError(`posición de problema fuera de rango: ${position}`);
  }
  return String.fromCharCode(65 + position);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
