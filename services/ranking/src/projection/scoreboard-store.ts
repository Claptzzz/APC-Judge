import { scoreOf } from '../domain/icpc.js';
import type { FirstSolver, ProblemCell, RankedRow, UserRow } from '../domain/types.js';
import type { RedisCommand, RedisLike } from './redis.js';

/**
 * Claves de la proyección de un contest. El hash tag `{id}` deja todas en el mismo slot, así
 * MULTI funciona también en Redis Cluster.
 * - `score`: sorted set user_id -> resueltos × 10^7 − penalización.
 * - `rows`: hash user_id -> JSON con el detalle por problema.
 * - `first`: hash problem_id -> user_id del primer AC.
 * - `meta`: hash con `builtAt`/`updatedAt` (ms). Su existencia marca la proyección como construida.
 */
export function scoreboardKeys(contestId: string) {
  const base = `ranking:sb:{${contestId}}`;
  return {
    score: `${base}:score`,
    rows: `${base}:rows`,
    first: `${base}:first`,
    meta: `${base}:meta`,
  };
}

export interface ScoreboardPage {
  total: number;
  rows: RankedRow[];
  /** problem_id -> user_id del primer AC. */
  firstSolvers: Map<string, string>;
  updatedAt: Date | undefined;
}

interface StoredRow {
  userId: string;
  username: string;
  solved: number;
  penaltyMinutes: number;
  problems: ProblemCell[];
}

function encodeRow(row: UserRow): string {
  const stored: StoredRow = {
    userId: row.userId,
    username: row.username,
    solved: row.solved,
    penaltyMinutes: row.penaltyMinutes,
    problems: row.problems,
  };
  return JSON.stringify(stored);
}

function decodeRow(json: string): UserRow {
  const r = JSON.parse(json) as StoredRow;
  return {
    userId: r.userId,
    username: r.username,
    solved: r.solved,
    penaltyMinutes: r.penaltyMinutes,
    problems: r.problems,
  };
}

function firstSolverCommands(key: string, firstSolvers: readonly FirstSolver[]): RedisCommand[] {
  const cmds: RedisCommand[] = [['del', key]];
  if (firstSolvers.length > 0) {
    cmds.push(['hset', key, ...firstSolvers.flatMap((f) => [f.problemId, f.userId])]);
  }
  return cmds;
}

/** Lectura/escritura de la proyección del scoreboard en Redis. */
export class ScoreboardStore {
  constructor(private readonly redis: RedisLike) {}

  ping(): Promise<unknown> {
    return this.redis.ping();
  }

  async hasContest(contestId: string): Promise<boolean> {
    return (await this.redis.exists(scoreboardKeys(contestId).meta)) > 0;
  }

  /**
   * Reemplaza la fila de un usuario (o la quita si `row` es undefined) y los primeros AC.
   * Idempotente: escribe el estado recalculado desde Postgres, no un delta.
   */
  async writeUser(
    contestId: string,
    userId: string,
    row: UserRow | undefined,
    firstSolvers: readonly FirstSolver[],
    now: Date,
  ): Promise<void> {
    const k = scoreboardKeys(contestId);
    const cmds: RedisCommand[] = row
      ? [
          ['zadd', k.score, scoreOf(row), userId],
          ['hset', k.rows, userId, encodeRow(row)],
        ]
      : [
          ['zrem', k.score, userId],
          ['hdel', k.rows, userId],
        ];
    cmds.push(...firstSolverCommands(k.first, firstSolvers));
    cmds.push(['hset', k.meta, 'updatedAt', now.getTime()]);
    await this.redis.transaction(cmds);
  }

  /** Reconstruye la proyección completa del contest en una sola transacción. */
  async replaceContest(
    contestId: string,
    rows: readonly UserRow[],
    firstSolvers: readonly FirstSolver[],
    now: Date,
  ): Promise<void> {
    const k = scoreboardKeys(contestId);
    const cmds: RedisCommand[] = [['del', k.score, k.rows, k.first, k.meta]];
    if (rows.length > 0) {
      cmds.push(['zadd', k.score, ...rows.flatMap((r) => [scoreOf(r), r.userId])]);
      cmds.push(['hset', k.rows, ...rows.flatMap((r) => [r.userId, encodeRow(r)])]);
    }
    cmds.push(...firstSolverCommands(k.first, firstSolvers).slice(1));
    cmds.push(['hset', k.meta, 'builtAt', now.getTime(), 'updatedAt', now.getTime()]);
    await this.redis.transaction(cmds);
  }

  /** Página del scoreboard ordenada por score (desc). Empates de score comparten rank. */
  async readPage(contestId: string, offset: number, limit: number): Promise<ScoreboardPage> {
    const k = scoreboardKeys(contestId);
    const [total, flat, first, updatedAt] = await Promise.all([
      this.redis.zcard(k.score),
      this.redis.zrevrangeWithScores(k.score, offset, offset + limit - 1),
      this.redis.hgetall(k.first),
      this.redis.hget(k.meta, 'updatedAt'),
    ]);
    const members: { userId: string; score: number }[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      members.push({ userId: flat[i]!, score: Number(flat[i + 1]) });
    }
    const jsons = await this.redis.hmget(
      k.rows,
      members.map((m) => m.userId),
    );

    const rows: RankedRow[] = [];
    let prevScore: number | undefined;
    let prevRank = 0;
    for (const [i, m] of members.entries()) {
      let rank: number;
      if (prevScore === undefined) {
        // Rank = 1 + cantidad de participantes con score estrictamente mayor.
        rank = 1 + (await this.redis.zcount(k.score, `(${m.score}`, '+inf'));
      } else {
        rank = m.score === prevScore ? prevRank : offset + i + 1;
      }
      prevScore = m.score;
      prevRank = rank;
      const json = jsons[i];
      if (!json) continue; // inconsistencia puntual: la corrige el siguiente evento o el rebuild
      rows.push({ ...decodeRow(json), rank });
    }
    return {
      total,
      rows,
      firstSolvers: new Map(Object.entries(first)),
      updatedAt: updatedAt ? new Date(Number(updatedAt)) : undefined,
    };
  }
}
