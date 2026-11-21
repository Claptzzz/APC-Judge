import { timestampDate, timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, createClient, createRouterTransport } from '@connectrpc/connect';
import { ContestStatus, RankingService, Verdict } from '@juez/contracts/es';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallContext, ProblemsGateway } from '../../src/clients/problems.js';
import { EventProcessor } from '../../src/events/processor.js';
import { requestContextInterceptor } from '../../src/grpc/interceptors.js';
import { encodeOffset } from '../../src/grpc/pagination.js';
import { createRankingServiceImpl } from '../../src/grpc/ranking-service.js';
import { ScoreboardProjector } from '../../src/projection/projector.js';
import { ScoreboardStore } from '../../src/projection/scoreboard-store.js';
import {
  FakeRedis,
  InMemoryRankingRepository,
  judgedEvent,
  makeContest,
  minutes,
  registeredEvent,
  silentLogger,
  testJwt,
  uuid,
} from '../helpers.js';
import type { TestJwt } from '../helpers.js';

const NOW = minutes(100);
const P = [uuid(1, 'a'), uuid(2, 'a'), uuid(3, 'a')];

class FakeProblems implements ProblemsGateway {
  calls: { ids: readonly string[]; ctx: CallContext }[] = [];
  error: Error | undefined;
  async assertProblemsExist(ids: readonly string[], ctx: CallContext) {
    this.calls.push({ ids, ctx });
    if (this.error) throw this.error;
  }
}

let jwt: TestJwt;
let repo: InMemoryRankingRepository;
let problems: FakeProblems;
let processor: EventProcessor;
let client: ReturnType<typeof createClient<typeof RankingService>>;

async function auth(role = 'CONTESTANT', sub = uuid(1)) {
  return {
    headers: { authorization: `Bearer ${await jwt.sign({ role, sub })}`, 'x-request-id': 'req-1' },
  };
}

beforeEach(async () => {
  jwt = await testJwt();
  repo = new InMemoryRankingRepository();
  problems = new FakeProblems();
  const projector = new ScoreboardProjector(
    repo,
    new ScoreboardStore(new FakeRedis()),
    silentLogger,
    undefined,
    {
      now: () => NOW,
    },
  );
  processor = new EventProcessor({ repo, projector, logger: silentLogger });
  const impl = createRankingServiceImpl({
    repo,
    projector,
    problems,
    verifier: jwt.verifier,
    now: () => NOW,
  });
  const transport = createRouterTransport(({ service }) => service(RankingService, impl), {
    router: { interceptors: [requestContextInterceptor(silentLogger)] },
  });
  client = createClient(RankingService, transport);
});

async function expectCode(p: Promise<unknown>, code: Code) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => ConnectError.from(e),
  );
  expect(err?.code, err?.rawMessage).toBe(code);
  return err!;
}

const validCreate = () => ({
  title: '  Copa UCN ',
  description: 'desc',
  startTime: timestampFromDate(minutes(0)),
  endTime: timestampFromDate(minutes(180)),
  problemIds: [P[2]!, P[0]!],
});

describe('autenticación', () => {
  it('todas las RPC exigen JWT', async () => {
    await expectCode(client.getContest({ id: uuid(1, 'c') }), Code.Unauthenticated);
    await expectCode(client.listContests({}), Code.Unauthenticated);
    await expectCode(client.getScoreboard({ contestId: uuid(1, 'c') }), Code.Unauthenticated);
    await expectCode(client.getUserStats({}), Code.Unauthenticated);
    await expectCode(client.createContest(validCreate()), Code.Unauthenticated);
    await expectCode(
      client.listContests({}, { headers: { authorization: 'Basic x' } }),
      Code.Unauthenticated,
    );
    await expectCode(
      client.listContests({}, { headers: { authorization: 'Bearer nope' } }),
      Code.Unauthenticated,
    );
  });
});

describe('CreateContest', () => {
  it('exige rol SETTER o ADMIN', async () => {
    await expectCode(
      client.createContest(validCreate(), await auth('CONTESTANT')),
      Code.PermissionDenied,
    );
  });

  it('crea el contest con problemas en orden, valida cada uno y propaga el token', async () => {
    const opts = await auth('SETTER', uuid(42));
    const { contest } = await client.createContest(validCreate(), opts);
    expect(contest).toMatchObject({
      title: 'Copa UCN',
      description: 'desc',
      problemIds: [P[2], P[0]],
      createdBy: uuid(42),
      status: ContestStatus.RUNNING,
    });
    expect(problems.calls).toEqual([
      { ids: [P[2], P[0]], ctx: { authorization: opts.headers.authorization, requestId: 'req-1' } },
    ]);
    expect(repo.contests.size).toBe(1);
  });

  it.each([
    ['title vacío', { title: '  ' }],
    ['start >= end', { endTime: timestampFromDate(minutes(0)) }],
    ['sin fechas', { startTime: undefined }],
    ['sin problemas', { problemIds: [] }],
    ['problem_id inválido', { problemIds: ['abc'] }],
    ['problemas repetidos', { problemIds: [P[0]!, P[0]!.toUpperCase()] }],
    [
      'demasiados problemas',
      { problemIds: Array.from({ length: 27 }, (_, i) => uuid(i + 1, 'a')) },
    ],
    ['description larga', { description: 'x'.repeat(20_001) }],
  ])('rechaza %s con INVALID_ARGUMENT', async (_name, patch) => {
    await expectCode(
      client.createContest({ ...validCreate(), ...patch }, await auth('ADMIN')),
      Code.InvalidArgument,
    );
    expect(problems.calls).toHaveLength(0);
  });

  it('propaga NOT_FOUND / UNAVAILABLE de problems y no crea el contest', async () => {
    problems.error = new ConnectError('problemas inexistentes', Code.NotFound);
    await expectCode(client.createContest(validCreate(), await auth('ADMIN')), Code.NotFound);
    problems.error = new ConnectError('problems no responde', Code.Unavailable);
    await expectCode(client.createContest(validCreate(), await auth('ADMIN')), Code.Unavailable);
    expect(repo.contests.size).toBe(0);
  });
});

describe('GetContest y ListContests', () => {
  beforeEach(() => {
    repo.addContest(
      makeContest({ id: uuid(1, 'c'), startTime: minutes(200), endTime: minutes(300) }),
    );
    repo.addContest(
      makeContest({ id: uuid(2, 'c'), startTime: minutes(50), endTime: minutes(150) }),
    );
    repo.addContest(
      makeContest({ id: uuid(3, 'c'), startTime: minutes(-90), endTime: minutes(-10) }),
    );
    repo.addContest(
      makeContest({ id: uuid(4, 'c'), startTime: minutes(-90), endTime: minutes(120) }),
    );
  });

  it('GetContest calcula el status con la hora actual y respeta el orden de problemas', async () => {
    const { contest } = await client.getContest({ id: uuid(1, 'c') }, await auth());
    expect(contest?.status).toBe(ContestStatus.UPCOMING);
    expect(contest?.problemIds).toEqual(P);
    expect(timestampDate(contest!.startTime!)).toEqual(minutes(200));
    expect((await client.getContest({ id: uuid(2, 'c') }, await auth())).contest?.status).toBe(
      ContestStatus.RUNNING,
    );
    expect((await client.getContest({ id: uuid(3, 'c') }, await auth())).contest?.status).toBe(
      ContestStatus.FINISHED,
    );
  });

  it('GetContest: NOT_FOUND e INVALID_ARGUMENT', async () => {
    await expectCode(client.getContest({ id: uuid(9, 'c') }, await auth()), Code.NotFound);
    await expectCode(client.getContest({ id: 'x' }, await auth()), Code.InvalidArgument);
  });

  it('ListContests pagina por start_time desc con cursor', async () => {
    const opts = await auth();
    const p1 = await client.listContests({ pageSize: 2 }, opts);
    expect(p1.contests.map((c) => c.id)).toEqual([uuid(1, 'c'), uuid(2, 'c')]);
    expect(p1.nextPageToken).not.toBe('');
    const p2 = await client.listContests({ pageSize: 2, pageToken: p1.nextPageToken }, opts);
    expect(p2.contests.map((c) => c.id)).toEqual([uuid(4, 'c'), uuid(3, 'c')]);
    expect(p2.nextPageToken).toBe('');
  });

  it('ListContests filtra por status', async () => {
    const opts = await auth();
    const running = await client.listContests({ status: ContestStatus.RUNNING }, opts);
    expect(running.contests.map((c) => c.id)).toEqual([uuid(2, 'c'), uuid(4, 'c')]);
    const finished = await client.listContests({ status: ContestStatus.FINISHED }, opts);
    expect(finished.contests.map((c) => c.id)).toEqual([uuid(3, 'c')]);
  });

  it('ListContests valida page_token, page_size y status', async () => {
    const opts = await auth();
    await expectCode(client.listContests({ pageToken: '%%%' }, opts), Code.InvalidArgument);
    await expectCode(
      client.listContests(
        { pageToken: Buffer.from('{"s":"x","i":"y"}').toString('base64url') },
        opts,
      ),
      Code.InvalidArgument,
    );
    await expectCode(client.listContests({ pageSize: -1 }, opts), Code.InvalidArgument);
    await expectCode(
      client.listContests({ status: 42 as ContestStatus }, opts),
      Code.InvalidArgument,
    );
  });
});

describe('GetScoreboard', () => {
  const contest = makeContest();
  const ev = (userId: string, problemId: string, verdict: Verdict, minute: number) =>
    judgedEvent({
      userId,
      problemId,
      verdict,
      contestId: contest.id,
      submittedAt: minutes(minute),
    });

  beforeEach(async () => {
    repo.addContest(contest);
    await processor.submissionJudged(ev(uuid(1), P[0]!, Verdict.WRONG_ANSWER, 5));
    await processor.submissionJudged(ev(uuid(1), P[0]!, Verdict.ACCEPTED, 10));
    await processor.submissionJudged(ev(uuid(2), P[1]!, Verdict.ACCEPTED, 7));
    await processor.submissionJudged(ev(uuid(2), P[0]!, Verdict.ACCEPTED, 8));
    await processor.submissionJudged(ev(uuid(3), P[2]!, Verdict.COMPILATION_ERROR, 1));
    await processor.userRegistered(registeredEvent(uuid(2), 'bob'));
  });

  it('devuelve filas ordenadas con detalle por problema, primer AC y username o user_id', async () => {
    const res = await client.getScoreboard({ contestId: contest.id }, await auth());
    expect(res.contestId).toBe(contest.id);
    expect(res.rows.map((r) => [r.rank, r.userId, r.username, r.solved, r.penaltyMinutes])).toEqual(
      [
        [1, uuid(2), 'bob', 2, 15],
        [2, uuid(1), uuid(1), 1, 30],
        [3, uuid(3), uuid(3), 0, 0],
      ],
    );
    const bob = res.rows[0]!;
    expect(bob.problems.map((p) => [p.problemId, p.solved, p.firstToSolve])).toEqual([
      [P[0], true, true],
      [P[1], true, true],
      [P[2], false, false],
    ]);
    expect(res.rows[1]!.problems[0]).toMatchObject({
      attempts: 2,
      solvedAtMinute: 10,
      penaltyMinutes: 30,
      firstToSolve: false,
    });
    expect(res.rows[2]!.problems[2]).toMatchObject({ attempts: 0, solved: false });
    expect(res.nextPageToken).toBe('');
    expect(res.updatedAt).toBeDefined();
  });

  it('pagina con page_token', async () => {
    const opts = await auth();
    const p1 = await client.getScoreboard({ contestId: contest.id, pageSize: 2 }, opts);
    expect(p1.rows).toHaveLength(2);
    expect(p1.nextPageToken).toBe(encodeOffset(2));
    const p2 = await client.getScoreboard(
      { contestId: contest.id, pageSize: 2, pageToken: p1.nextPageToken },
      opts,
    );
    expect(p2.rows.map((r) => r.rank)).toEqual([3]);
    await expectCode(
      client.getScoreboard({ contestId: contest.id, pageToken: encodeOffset(-1) }, opts),
      Code.InvalidArgument,
    );
  });

  it('NOT_FOUND si el contest no existe', async () => {
    await expectCode(
      client.getScoreboard({ contestId: uuid(8, 'c') }, await auth()),
      Code.NotFound,
    );
  });
});

describe('GetUserStats', () => {
  beforeEach(async () => {
    const e = (problemId: string, verdict: Verdict) =>
      processor.submissionJudged(
        judgedEvent({ userId: uuid(1), problemId, verdict, submittedAt: minutes(1) }),
      );
    await e(P[0]!, Verdict.WRONG_ANSWER);
    await e(P[0]!, Verdict.ACCEPTED);
    await e(P[1]!, Verdict.COMPILATION_ERROR);
    await e(P[0]!, Verdict.ACCEPTED);
  });

  it('por defecto devuelve las del usuario del token', async () => {
    const res = await client.getUserStats({}, await auth('CONTESTANT', uuid(1)));
    expect(res).toMatchObject({
      userId: uuid(1),
      username: uuid(1),
      solvedCount: 1,
      attemptedCount: 2,
      totalSubmissions: 4,
      solvedProblemIds: [P[0]],
    });
    expect(res.verdictCounts.map((v) => [v.verdict, v.count])).toEqual([
      [Verdict.ACCEPTED, 2],
      [Verdict.WRONG_ANSWER, 1],
      [Verdict.COMPILATION_ERROR, 1],
    ]);
  });

  it('acepta otro user_id y valida el formato', async () => {
    await processor.userRegistered(registeredEvent(uuid(2), 'zoe'));
    const res = await client.getUserStats({ userId: uuid(2) }, await auth());
    expect(res).toMatchObject({ username: 'zoe', totalSubmissions: 0, solvedCount: 0 });
    await expectCode(client.getUserStats({ userId: 'nope' }, await auth()), Code.InvalidArgument);
  });

  it('un error inesperado se oculta como INTERNAL', async () => {
    vi.spyOn(repo, 'userStats').mockRejectedValueOnce(new Error('boom'));
    const err = await expectCode(client.getUserStats({}, await auth()), Code.Internal);
    expect(err.rawMessage).toBe('error interno');
    expect(err.metadata.get('x-request-id')).toBe('req-1');
  });
});
