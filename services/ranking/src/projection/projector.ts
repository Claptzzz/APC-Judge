import { backoffDelay, DEFAULT_INITIAL_RETRY_MS, DEFAULT_MAX_RETRY_MS } from '../backoff.js';
import {
  computeContestRows,
  computeFirstSolvers,
  computeUserRow,
  rankRows,
} from '../domain/icpc.js';
import type { Contest } from '../domain/types.js';
import type { Logger } from '../logger.js';
import type { Metrics } from '../metrics.js';
import type { RankingRepository } from '../repository.js';
import type { ScoreboardPage, ScoreboardStore } from './scoreboard-store.js';

export interface ProjectorOptions {
  now?: () => Date;
  /** Backoff de la reparación en segundo plano de la proyección degradada. */
  repairInitialMs?: number;
  repairMaxMs?: number;
}

export interface ProjectionStatus {
  degraded: boolean;
  /** Contests con alguna fila sin escribir en Redis. */
  dirtyContests: string[];
  /** Usuarios cuyo username no se pudo propagar a la proyección. */
  pendingUsers: number;
  lastError: string | undefined;
}

export interface ScoreboardResult extends ScoreboardPage {
  /** `redis` normalmente; `postgres` si Redis no respondió y se calculó desde la BD. */
  source: 'redis' | 'postgres';
}

/**
 * Mantiene la proyección del scoreboard en Redis a partir de Postgres (fuente de verdad).
 *
 * - Después de aplicar un evento se recalcula desde Postgres la fila del usuario afectado y se
 *   escribe en Redis: es idempotente y no depende del orden de llegada de los eventos.
 * - Si la escritura falla, el error se registra, la proyección queda marcada como degradada
 *   (visible en /ready) y una reparación en segundo plano (backoff, tope 30 s) reconstruye los
 *   contests afectados desde Postgres. El evento NO se reintenta: ya está confirmado en la BD.
 */
export class ScoreboardProjector {
  private readonly dirty = new Map<string, Set<string>>();
  private readonly pendingUsers = new Set<string>();
  private lastError: string | undefined;
  private repairTimer: NodeJS.Timeout | undefined;
  private repairAttempt = 0;
  private stopped = false;
  private readonly now: () => Date;

  constructor(
    private readonly repo: RankingRepository,
    private readonly store: ScoreboardStore,
    private readonly logger: Logger,
    private readonly metrics?: Metrics,
    private readonly opts: ProjectorOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  status(): ProjectionStatus {
    return {
      degraded: this.dirty.size > 0 || this.pendingUsers.size > 0,
      dirtyContests: [...this.dirty.keys()],
      pendingUsers: this.pendingUsers.size,
      lastError: this.lastError,
    };
  }

  /**
   * Recalcula y escribe la fila de `userId` en el scoreboard de `contestId`. Nunca lanza:
   * devuelve `false` si la proyección quedó desactualizada.
   */
  async projectUser(contestId: string, userId: string): Promise<boolean> {
    try {
      const contest = await this.repo.findContest(contestId);
      // Contest inexistente: la submission ya quedó guardada (estadísticas), sin scoreboard.
      if (!contest) return true;
      if (!(await this.store.hasContest(contest.id))) {
        // Sin proyección previa: escribir una sola fila la dejaría incompleta.
        await this.buildContest(contest);
      } else {
        const [mine, accepted, names] = await Promise.all([
          this.repo.contestSubmissions(contest, { userId }),
          this.repo.contestSubmissions(contest, { acceptedOnly: true }),
          this.repo.usernames([userId]),
        ]);
        const row = computeUserRow(contest, userId, names.get(userId) ?? '', mine);
        await this.store.writeUser(
          contest.id,
          userId,
          row,
          computeFirstSolvers(contest, accepted),
          this.now(),
        );
      }
      this.markClean(contestId, userId);
      this.metrics?.projectionWrites.inc({ status: 'ok' });
      return true;
    } catch (err) {
      this.markDirty(contestId, userId, err);
      return false;
    }
  }

  /** Re-proyecta al usuario en todos los contests donde participa (cambio de username). */
  async projectUserEverywhere(userId: string): Promise<boolean> {
    let contestIds: string[];
    try {
      contestIds = await this.repo.contestsOfUser(userId);
    } catch (err) {
      this.pendingUsers.add(userId);
      this.recordFailure(err, { userId }, 'no se pudieron leer los contests del usuario');
      return false;
    }
    this.pendingUsers.delete(userId);
    let ok = true;
    for (const contestId of contestIds) {
      ok = (await this.projectUser(contestId, userId)) && ok;
    }
    return ok;
  }

  /** Reconstruye desde Postgres la proyección de un contest. Lanza si falla. */
  async rebuildContest(contestOrId: Contest | string): Promise<boolean> {
    const contest =
      typeof contestOrId === 'string' ? await this.repo.findContest(contestOrId) : contestOrId;
    if (!contest) return false;
    await this.buildContest(contest);
    this.dirty.delete(contest.id);
    return true;
  }

  /** Reconstruye la proyección de todos los contests (script `scoreboard:rebuild`). */
  async rebuildAll(): Promise<number> {
    const ids = await this.repo.listContestIds();
    for (const id of ids) await this.rebuildContest(id);
    return ids.length;
  }

  /**
   * Página del scoreboard. Lee de Redis; si la proyección del contest no existe, la reconstruye.
   * Si Redis no responde, calcula la página desde Postgres para seguir atendiendo.
   */
  async scoreboard(contest: Contest, offset: number, limit: number): Promise<ScoreboardResult> {
    try {
      if (!(await this.store.hasContest(contest.id))) await this.rebuildContest(contest);
      return { ...(await this.store.readPage(contest.id, offset, limit)), source: 'redis' };
    } catch (err) {
      this.logger.warn(
        { err, contestId: contest.id },
        'redis no disponible para el scoreboard; se calcula desde postgres',
      );
      const { rows, firstSolvers } = await this.computeFromPostgres(contest);
      const ranked = rankRows(rows);
      return {
        total: ranked.length,
        rows: ranked.slice(offset, offset + limit),
        firstSolvers: new Map(firstSolvers.map((f) => [f.problemId, f.userId])),
        updatedAt: this.now(),
        source: 'postgres',
      };
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.repairTimer) clearTimeout(this.repairTimer);
    this.repairTimer = undefined;
  }

  private async computeFromPostgres(contest: Contest) {
    const subs = await this.repo.contestSubmissions(contest);
    const names = await this.repo.usernames([...new Set(subs.map((s) => s.userId))]);
    return {
      rows: computeContestRows(contest, subs, names),
      firstSolvers: computeFirstSolvers(contest, subs),
    };
  }

  private async buildContest(contest: Contest): Promise<void> {
    const { rows, firstSolvers } = await this.computeFromPostgres(contest);
    await this.store.replaceContest(contest.id, rows, firstSolvers, this.now());
  }

  private markClean(contestId: string, userId: string): void {
    const users = this.dirty.get(contestId);
    if (!users) return;
    users.delete(userId);
    if (users.size === 0) this.dirty.delete(contestId);
  }

  private markDirty(contestId: string, userId: string, err: unknown): void {
    const users = this.dirty.get(contestId) ?? new Set<string>();
    users.add(userId);
    this.dirty.set(contestId, users);
    this.recordFailure(
      err,
      { contestId, userId },
      'no se pudo actualizar la proyección del scoreboard',
    );
  }

  private recordFailure(err: unknown, fields: Record<string, string>, msg: string): void {
    this.lastError = err instanceof Error ? err.message : String(err);
    this.metrics?.projectionWrites.inc({ status: 'error' });
    this.logger.error({ err, ...fields }, `${msg}; proyección degradada`);
    this.scheduleRepair();
  }

  private scheduleRepair(): void {
    if (this.stopped || this.repairTimer) return;
    const delayMs = backoffDelay(
      this.repairAttempt,
      this.opts.repairInitialMs ?? DEFAULT_INITIAL_RETRY_MS,
      this.opts.repairMaxMs ?? DEFAULT_MAX_RETRY_MS,
    );
    this.repairAttempt++;
    this.repairTimer = setTimeout(() => {
      this.repairTimer = undefined;
      void this.repair();
    }, delayMs);
    this.repairTimer.unref();
  }

  /** Reconstruye los contests degradados y re-proyecta los usuarios pendientes. */
  async repair(): Promise<boolean> {
    for (const contestId of [...this.dirty.keys()]) {
      try {
        if (!(await this.rebuildContest(contestId))) this.dirty.delete(contestId);
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
      }
    }
    for (const userId of [...this.pendingUsers]) {
      try {
        const contestIds = await this.repo.contestsOfUser(userId);
        this.pendingUsers.delete(userId);
        for (const c of contestIds) await this.projectUser(c, userId);
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
      }
    }
    const { degraded } = this.status();
    if (degraded) {
      this.scheduleRepair();
    } else {
      this.repairAttempt = 0;
      this.lastError = undefined;
      this.logger.info('proyección del scoreboard reparada');
    }
    return !degraded;
  }
}
