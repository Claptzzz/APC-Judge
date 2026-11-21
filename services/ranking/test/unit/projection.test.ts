import { Verdict } from '@juez/contracts/es';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventProcessor } from '../../src/events/processor.js';
import { createMetrics } from '../../src/metrics.js';
import { ScoreboardProjector } from '../../src/projection/projector.js';
import { scoreboardKeys, ScoreboardStore } from '../../src/projection/scoreboard-store.js';
import {
  FakeRedis,
  InMemoryRankingRepository,
  judgedEvent,
  makeContest,
  memoryLogger,
  minutes,
  registeredEvent,
  silentLogger,
  uuid,
} from '../helpers.js';

const contest = makeContest();
const [A, B] = contest.problemIds as [string, string];
const NOW = minutes(500);

function setup(opts: { logger?: typeof silentLogger } = {}) {
  const repo = new InMemoryRankingRepository();
  repo.addContest(contest);
  const redis = new FakeRedis();
  const store = new ScoreboardStore(redis);
  const metrics = createMetrics({ defaultMetrics: false });
  const projector = new ScoreboardProjector(repo, store, opts.logger ?? silentLogger, metrics, {
    now: () => NOW,
    repairInitialMs: 10,
    repairMaxMs: 40,
  });
  const processor = new EventProcessor({ repo, projector, logger: silentLogger, now: () => NOW });
  return { repo, redis, store, projector, processor, metrics };
}

const judged = (
  userId: string,
  problemId: string,
  verdict: Verdict,
  minute: number,
  extra: Parameters<typeof judgedEvent>[0] = {},
) =>
  judgedEvent({
    userId,
    problemId,
    verdict,
    contestId: contest.id,
    submittedAt: minutes(minute),
    ...extra,
  });

async function board(store: ScoreboardStore) {
  const page = await store.readPage(contest.id, 0, 100);
  return page.rows.map((r) => ({
    userId: r.userId,
    rank: r.rank,
    solved: r.solved,
    penalty: r.penaltyMinutes,
    username: r.username,
  }));
}

describe('proyección del scoreboard', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => ctx.projector.stop());

  it('eventos desordenados producen la misma penalización que en orden', async () => {
    // Llegan: AC (min 50), WA (min 10), CE (min 5), WA (min 60, posterior al AC).
    for (const e of [
      judged(uuid(1), A, Verdict.ACCEPTED, 50),
      judged(uuid(1), A, Verdict.WRONG_ANSWER, 10),
      judged(uuid(1), A, Verdict.COMPILATION_ERROR, 5),
      judged(uuid(1), A, Verdict.WRONG_ANSWER, 60),
    ]) {
      await ctx.processor.submissionJudged(e);
    }
    expect(await board(ctx.store)).toEqual([
      { userId: uuid(1), rank: 1, solved: 1, penalty: 50 + 20, username: '' },
    ]);
    // Un AC anterior que llega al final reemplaza al primero.
    await ctx.processor.submissionJudged(judged(uuid(1), A, Verdict.ACCEPTED, 8));
    expect((await board(ctx.store))[0]).toMatchObject({ solved: 1, penalty: 8 });
  });

  it('CE no penaliza en el scoreboard', async () => {
    await ctx.processor.submissionJudged(judged(uuid(1), A, Verdict.COMPILATION_ERROR, 1));
    await ctx.processor.submissionJudged(judged(uuid(1), A, Verdict.COMPILATION_ERROR, 2));
    await ctx.processor.submissionJudged(judged(uuid(1), A, Verdict.ACCEPTED, 3));
    const page = await ctx.store.readPage(contest.id, 0, 10);
    expect(page.rows[0]?.problems[0]).toMatchObject({
      solved: true,
      attempts: 1,
      penaltyMinutes: 3,
    });
  });

  it('submissions fuera de la ventana se guardan pero no entran al scoreboard', async () => {
    await ctx.processor.submissionJudged(judged(uuid(2), A, Verdict.ACCEPTED, -5));
    await ctx.processor.submissionJudged(judged(uuid(2), B, Verdict.ACCEPTED, 300));
    expect(ctx.repo.submissions.size).toBe(2);
    expect(await board(ctx.store)).toEqual([]);
    // La proyección existe (vacía): no se reconstruye en cada lectura.
    expect(await ctx.store.hasContest(contest.id)).toBe(true);
  });

  it('eventos duplicados se descartan sin duplicar intentos', async () => {
    const wa = judged(uuid(1), A, Verdict.WRONG_ANSWER, 10);
    expect(await ctx.processor.submissionJudged(wa)).toBe('processed');
    expect(await ctx.processor.submissionJudged(wa)).toBe('duplicate');
    await ctx.processor.submissionJudged(judged(uuid(1), A, Verdict.ACCEPTED, 20));
    expect((await board(ctx.store))[0]).toMatchObject({ penalty: 20 + 20 });
    const reg = registeredEvent(uuid(1), 'alice');
    expect(await ctx.processor.userRegistered(reg)).toBe('processed');
    expect(await ctx.processor.userRegistered(reg)).toBe('duplicate');
  });

  it('un duplicado re-proyecta la fila (repara una caída entre el commit y Redis)', async () => {
    const ac = judged(uuid(1), A, Verdict.ACCEPTED, 10);
    ctx.redis.down = true;
    await ctx.processor.submissionJudged(ac);
    ctx.redis.down = false;
    expect(await ctx.processor.submissionJudged(ac)).toBe('duplicate');
    expect(await board(ctx.store)).toHaveLength(1);
  });

  it('contest inexistente: guarda la submission y no toca ningún scoreboard', async () => {
    const e = judgedEvent({ contestId: uuid(7, 'c'), submittedAt: minutes(1) });
    expect(await ctx.processor.submissionJudged(e)).toBe('processed');
    expect(ctx.repo.submissions.size).toBe(1);
    expect(ctx.redis.keys.size).toBe(0);
    expect(ctx.projector.status().degraded).toBe(false);
  });

  it('submission sin contest: solo estadísticas', async () => {
    await ctx.processor.submissionJudged(judgedEvent({ submittedAt: minutes(1) }));
    expect(ctx.redis.transactions).toBe(0);
  });

  it('user.registered actualiza el username en los scoreboards donde participa', async () => {
    await ctx.processor.submissionJudged(judged(uuid(1), A, Verdict.ACCEPTED, 10));
    expect((await board(ctx.store))[0]?.username).toBe('');
    await ctx.processor.userRegistered(registeredEvent(uuid(1), 'alice'));
    expect((await board(ctx.store))[0]?.username).toBe('alice');
  });

  it('marca el primer AC (menor submitted_at) por problema', async () => {
    await ctx.processor.submissionJudged(judged(uuid(1), A, Verdict.ACCEPTED, 30));
    await ctx.processor.submissionJudged(judged(uuid(2), A, Verdict.ACCEPTED, 12));
    const page = await ctx.store.readPage(contest.id, 0, 10);
    expect(page.firstSolvers.get(A)).toBe(uuid(2));
  });

  it('empates comparten rank y la paginación conserva el rank global', async () => {
    await ctx.processor.submissionJudged(judged(uuid(1), A, Verdict.ACCEPTED, 10));
    await ctx.processor.submissionJudged(judged(uuid(2), A, Verdict.ACCEPTED, 10));
    await ctx.processor.submissionJudged(judged(uuid(3), A, Verdict.ACCEPTED, 5));
    await ctx.processor.submissionJudged(judged(uuid(4), A, Verdict.WRONG_ANSWER, 5));
    expect((await board(ctx.store)).map((r) => r.rank)).toEqual([1, 2, 2, 4]);
    const p2 = await ctx.store.readPage(contest.id, 2, 2);
    expect(p2.total).toBe(4);
    expect(p2.rows.map((r) => [r.userId, r.rank])).toEqual([
      [uuid(1), 2],
      [uuid(4), 4],
    ]);
    expect(await ctx.redis.zrevrangeWithScores(scoreboardKeys(contest.id).score, 0, 0)).toEqual([
      uuid(3),
      String(10_000_000 - 5),
    ]);
  });

  it('una fila que deja de contar (re-juzgamiento) se quita de la proyección', async () => {
    const submissionId = uuid(77, 'f');
    await ctx.processor.submissionJudged(
      judged(uuid(1), A, Verdict.ACCEPTED, 10, { submissionId, occurredAt: minutes(11) }),
    );
    // Re-juzgado como CE (otro event_id, más reciente): sigue apareciendo con 0 resueltos.
    await ctx.processor.submissionJudged(
      judged(uuid(1), A, Verdict.COMPILATION_ERROR, 10, { submissionId, occurredAt: minutes(12) }),
    );
    expect(await board(ctx.store)).toEqual([
      { userId: uuid(1), rank: 1, solved: 0, penalty: 0, username: '' },
    ]);
    // Si la fila deja de tener submissions relevantes, writeUser la elimina.
    await ctx.store.writeUser(contest.id, uuid(1), undefined, [], NOW);
    expect(await board(ctx.store)).toEqual([]);
  });
});

describe('fallo de Redis después del commit', () => {
  it('no reintenta el evento, deja la proyección degradada y el siguiente evento la corrige', async () => {
    const { logger, lines } = memoryLogger();
    const ctx = setup({ logger });
    ctx.projector.stop(); // sin reparación en segundo plano: probamos el siguiente evento
    await ctx.processor.submissionJudged(judged(uuid(1), A, Verdict.WRONG_ANSWER, 5));

    ctx.redis.down = true;
    // El evento se confirma en Postgres y NO lanza (no se reintenta por un fallo de Redis).
    await expect(
      ctx.processor.submissionJudged(judged(uuid(1), A, Verdict.ACCEPTED, 9)),
    ).resolves.toBe('processed');
    expect(ctx.repo.submissions.size).toBe(2);
    expect(ctx.projector.status()).toMatchObject({
      degraded: true,
      dirtyContests: [contest.id],
      lastError: 'redis no disponible',
    });
    expect(lines().some((l) => l.level === 'error' && l.contestId === contest.id)).toBe(true);
    expect(await ctx.metrics.projectionWrites.get()).toMatchObject({
      values: expect.arrayContaining([expect.objectContaining({ labels: { status: 'error' } })]),
    });

    ctx.redis.down = false;
    expect((await board(ctx.store))[0]).toMatchObject({ solved: 0 }); // aún desactualizada
    await ctx.processor.submissionJudged(judged(uuid(1), B, Verdict.WRONG_ANSWER, 20));
    expect((await board(ctx.store))[0]).toMatchObject({ solved: 1, penalty: 9 + 20 });
    expect(ctx.projector.status().degraded).toBe(false);
  });

  it('la reparación en segundo plano reconstruye el contest cuando Redis vuelve', async () => {
    const ctx = setup();
    ctx.redis.down = true;
    await ctx.processor.submissionJudged(judged(uuid(1), A, Verdict.ACCEPTED, 9));
    await ctx.processor.submissionJudged(judged(uuid(2), A, Verdict.ACCEPTED, 3));
    expect(ctx.projector.status().degraded).toBe(true);
    ctx.redis.down = false;
    await vi.waitFor(() => expect(ctx.projector.status().degraded).toBe(false), {
      timeout: 2_000,
    });
    expect((await board(ctx.store)).map((r) => r.userId)).toEqual([uuid(2), uuid(1)]);
    ctx.projector.stop();
  });

  it('si la BD falla al recalcular tras el commit, también queda degradada sin lanzar', async () => {
    const ctx = setup();
    ctx.projector.stop();
    ctx.repo.readFailure = new Error('bd caída');
    await expect(
      ctx.processor.submissionJudged(judged(uuid(1), A, Verdict.ACCEPTED, 9)),
    ).resolves.toBe('processed');
    await expect(ctx.processor.userRegistered(registeredEvent(uuid(1), 'bob'))).resolves.toBe(
      'processed',
    );
    expect(ctx.projector.status()).toMatchObject({ degraded: true, pendingUsers: 1 });
    ctx.repo.readFailure = undefined;
    expect(await ctx.projector.repair()).toBe(true);
    expect((await board(ctx.store))[0]).toMatchObject({ username: 'bob', solved: 1 });
  });

  it('la reparación sigue reintentando mientras Redis no vuelva', async () => {
    const ctx = setup();
    ctx.projector.stop();
    ctx.redis.down = true;
    await ctx.processor.submissionJudged(judged(uuid(1), A, Verdict.ACCEPTED, 9));
    expect(await ctx.projector.repair()).toBe(false);
    expect(ctx.projector.status().degraded).toBe(true);
  });
});

describe('rebuild', () => {
  it('regenera desde Postgres la misma proyección que las actualizaciones incrementales', async () => {
    const ctx = setup();
    const events = [
      judged(uuid(1), A, Verdict.WRONG_ANSWER, 4),
      judged(uuid(1), A, Verdict.ACCEPTED, 14),
      judged(uuid(2), B, Verdict.ACCEPTED, 7),
      judged(uuid(3), A, Verdict.COMPILATION_ERROR, 7),
      judged(uuid(2), A, Verdict.ACCEPTED, 70),
    ];
    for (const e of events) await ctx.processor.submissionJudged(e);
    await ctx.processor.userRegistered(registeredEvent(uuid(2), 'bob'));
    const incremental = await ctx.store.readPage(contest.id, 0, 100);

    ctx.redis.keys.clear(); // Redis perdió todo
    expect(await ctx.projector.rebuildAll()).toBe(1);
    const rebuilt = await ctx.store.readPage(contest.id, 0, 100);
    expect(rebuilt.rows).toEqual(incremental.rows);
    expect(rebuilt.firstSolvers).toEqual(incremental.firstSolvers);
    expect(rebuilt.rows[0]).toMatchObject({ username: 'bob', solved: 2 });
  });

  it('rebuild de un contest inexistente devuelve false', async () => {
    const ctx = setup();
    expect(await ctx.projector.rebuildContest(uuid(5, 'c'))).toBe(false);
  });

  it('un evento sobre un contest sin proyección la construye completa (no una sola fila)', async () => {
    const ctx = setup();
    await ctx.processor.submissionJudged(judged(uuid(1), A, Verdict.ACCEPTED, 9));
    ctx.redis.keys.clear();
    await ctx.processor.submissionJudged(judged(uuid(2), A, Verdict.ACCEPTED, 19));
    expect((await board(ctx.store)).map((r) => r.userId)).toEqual([uuid(1), uuid(2)]);
  });

  it('GetScoreboard reconstruye la proyección si no existe', async () => {
    const ctx = setup();
    await ctx.processor.submissionJudged(judged(uuid(1), A, Verdict.ACCEPTED, 9));
    ctx.redis.keys.clear();
    const page = await ctx.projector.scoreboard(contest, 0, 10);
    expect(page.source).toBe('redis');
    expect(page.rows).toHaveLength(1);
    expect(await ctx.store.hasContest(contest.id)).toBe(true);
  });

  it('GetScoreboard calcula desde Postgres si Redis no responde', async () => {
    const ctx = setup();
    await ctx.processor.submissionJudged(judged(uuid(1), A, Verdict.ACCEPTED, 9));
    await ctx.processor.submissionJudged(judged(uuid(2), A, Verdict.ACCEPTED, 3));
    ctx.redis.down = true;
    const page = await ctx.projector.scoreboard(contest, 1, 10);
    expect(page).toMatchObject({ source: 'postgres', total: 2, updatedAt: NOW });
    expect(page.rows.map((r) => [r.userId, r.rank])).toEqual([[uuid(1), 2]]);
    expect(page.firstSolvers.get(A)).toBe(uuid(2));
    ctx.projector.stop();
  });
});
