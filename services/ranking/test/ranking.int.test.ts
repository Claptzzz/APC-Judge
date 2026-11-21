// Integración contra la infraestructura local (`pnpm infra:up`): Postgres + Redis reales.
// Usa ids aleatorios, así que no borra datos existentes. Excluido del CI.
import { randomUUID } from 'node:crypto';
import { Verdict } from '@juez/contracts/es';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/db/client.js';
import type { Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { EventProcessor } from '../src/events/processor.js';
import { isPermanentDbError } from '../src/kafka/consumer.js';
import { ScoreboardProjector } from '../src/projection/projector.js';
import { createRedis, ioredisAdapter } from '../src/projection/redis.js';
import { ScoreboardStore } from '../src/projection/scoreboard-store.js';
import { DrizzleRankingRepository } from '../src/repository.js';
import { judgedEvent, registeredEvent, silentLogger } from './helpers.js';

let database: Database;
let redis: ReturnType<typeof createRedis>;
let repo: DrizzleRankingRepository;
let store: ScoreboardStore;
let projector: ScoreboardProjector;
let processor: EventProcessor;

const start = new Date(Date.now() - 60 * 60_000);
const at = (m: number) => new Date(start.getTime() + m * 60_000);

beforeAll(async () => {
  database = createDatabase(process.env.RANKING_DATABASE_URL!);
  await runMigrations(database.db);
  redis = createRedis(process.env.RANKING_REDIS_URL!, silentLogger);
  await new Promise<void>((resolve) =>
    redis.status === 'ready' ? resolve() : redis.once('ready', () => resolve()),
  );
  repo = new DrizzleRankingRepository(database.db);
  store = new ScoreboardStore(ioredisAdapter(redis));
  projector = new ScoreboardProjector(repo, store, silentLogger);
  processor = new EventProcessor({ repo, projector, logger: silentLogger });
});

afterAll(async () => {
  projector?.stop();
  redis?.disconnect();
  await database?.close();
});

describe('ranking contra Postgres + Redis', () => {
  const problems = [randomUUID(), randomUUID()];
  const [alice, bob] = [randomUUID(), randomUUID()];

  it('crea contests y los lista paginados con estado', async () => {
    const c = await repo.createContest({
      title: 'int',
      description: '',
      startTime: start,
      endTime: at(180),
      problemIds: problems,
      createdBy: alice,
    });
    const found = await repo.findContest(c.id);
    expect(found?.problemIds).toEqual(problems);
    const running = await repo.listContests({ limit: 500, status: 'RUNNING', now: new Date() });
    expect(running.map((x) => x.id)).toContain(c.id);
    const upcoming = await repo.listContests({ limit: 500, status: 'UPCOMING', now: new Date() });
    expect(upcoming.map((x) => x.id)).not.toContain(c.id);
    const page = await repo.listContests({
      limit: 1,
      after: { startTime: at(1), id: c.id },
      now: new Date(),
    });
    expect(page.every((x) => x.startTime <= at(1))).toBe(true);
  });

  it('flujo completo: eventos desordenados, duplicados, rebuild y estadísticas', async () => {
    const contest = await repo.createContest({
      title: 'flujo',
      description: '',
      startTime: start,
      endTime: at(180),
      problemIds: problems,
      createdBy: alice,
    });
    const ev = (userId: string, p: number, verdict: Verdict, m: number, extra = {}) =>
      judgedEvent({
        userId,
        problemId: problems[p]!,
        verdict,
        contestId: contest.id,
        submittedAt: at(m),
        ...extra,
      });

    const wa = ev(alice, 0, Verdict.WRONG_ANSWER, 10);
    for (const e of [
      ev(alice, 0, Verdict.ACCEPTED, 30),
      wa,
      ev(alice, 0, Verdict.COMPILATION_ERROR, 5),
      ev(bob, 1, Verdict.ACCEPTED, 12),
      ev(bob, 0, Verdict.ACCEPTED, 200), // fuera de la ventana
    ]) {
      expect(await processor.submissionJudged(e)).toBe('processed');
    }
    expect(await processor.submissionJudged(wa)).toBe('duplicate');
    await processor.userRegistered(registeredEvent(alice, `alice-${alice.slice(0, 4)}`));

    const page = await store.readPage(contest.id, 0, 10);
    expect(page.rows.map((r) => [r.userId, r.rank, r.solved, r.penaltyMinutes])).toEqual([
      [bob, 1, 1, 12],
      [alice, 2, 1, 50],
    ]);
    expect(page.rows[1]?.username).toMatch(/^alice-/);
    expect(page.firstSolvers.get(problems[1]!)).toBe(bob);

    // Rebuild desde Postgres = misma proyección.
    await redis.del(`ranking:sb:{${contest.id}}:meta`, `ranking:sb:{${contest.id}}:score`);
    expect(await projector.rebuildContest(contest.id)).toBe(true);
    expect((await store.readPage(contest.id, 0, 10)).rows).toEqual(page.rows);

    expect(await repo.contestsOfUser(alice)).toEqual([contest.id]);
    const stats = await repo.userStats(alice);
    expect(stats).toMatchObject({
      totalSubmissions: 3,
      attemptedCount: 1,
      solvedProblemIds: [problems[0]],
    });
    expect(stats.username).toMatch(/^alice-/);
  });

  it('re-juzgamiento: otro event_id para la misma submission actualiza el veredicto', async () => {
    const submissionId = randomUUID();
    const user = randomUUID();
    const base = { submissionId, userId: user, problemId: problems[0]!, submittedAt: at(1) };
    await processor.submissionJudged(
      judgedEvent({ ...base, verdict: Verdict.WRONG_ANSWER, occurredAt: at(2) }),
    );
    await processor.submissionJudged(
      judgedEvent({ ...base, verdict: Verdict.ACCEPTED, occurredAt: at(3) }),
    );
    // Uno más viejo que llega tarde no pisa al más reciente.
    await processor.submissionJudged(
      judgedEvent({ ...base, verdict: Verdict.RUNTIME_ERROR, occurredAt: at(1) }),
    );
    const stats = await repo.userStats(user);
    expect(stats.verdictCounts).toEqual([{ verdict: 'ACCEPTED', count: 1 }]);
  });

  it('contest inexistente: guarda la submission (estadísticas) sin scoreboard', async () => {
    const user = randomUUID();
    const contestId = randomUUID();
    await processor.submissionJudged(judgedEvent({ userId: user, contestId, submittedAt: at(1) }));
    expect((await repo.userStats(user)).totalSubmissions).toBe(1);
    expect(await store.hasContest(contestId)).toBe(false);
    expect(await repo.contestsOfUser(user)).toEqual([]);
  });

  it('un error de datos de Postgres se clasifica como permanente', async () => {
    const err = await database.db.execute('select $$x$$::uuid').catch((e: unknown) => e);
    expect(isPermanentDbError(err)).toBe(true);
  });
});
