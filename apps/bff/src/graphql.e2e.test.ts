// Resolvers a través de la app real (Nest + Apollo + express) con los clientes gRPC mockeados.
import { status as GrpcStatus } from '@grpc/grpc-js';
import { common } from '@juez/contracts/nest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantService } from './assistant/assistant.service.js';
import {
  ADMIN,
  ALICE,
  BOB,
  CONTEST_ID,
  createKeys,
  fakeBackend,
  fakeConsumer,
  PROBLEM_2_ID,
  PROBLEM_ID,
  sampleProblem,
  sampleSubmission,
  SETTER,
  signToken,
  silentLogger,
  startTestApp,
  SUBMISSION_ID,
  ts,
  upstreamError,
} from './test-utils/fixtures.js';
import type { FakeBackend, Keys, TestApp } from './test-utils/fixtures.js';

let keys: Keys;
let app: TestApp;
let backend: FakeBackend;
let alice: string;
let bob: string;
let admin: string;
let setter: string;

beforeAll(async () => {
  keys = await createKeys();
  backend = fakeBackend(keys);
  app = await startTestApp(keys, { backend });
  [alice, bob, admin, setter] = await Promise.all([
    signToken(keys, ALICE),
    signToken(keys, BOB),
    signToken(keys, ADMIN),
    signToken(keys, SETTER),
  ]);
});

afterAll(() => app.close());

beforeEach(() => {
  // Restaura los mocks a sus valores por defecto entre tests.
  const fresh = fakeBackend(keys);
  for (const service of Object.keys(fresh) as Array<keyof FakeBackend>) {
    for (const [method, fn] of Object.entries(fresh[service])) {
      (backend[service] as Record<string, unknown>)[method] = fn;
    }
  }
});

const codes = (r: { errors?: Array<{ extensions?: { code?: string } }> }) =>
  r.errors?.map((e) => e.extensions?.code);

describe('autenticación', () => {
  it('me sin token → UNAUTHENTICATED', async () => {
    const r = await app.gql('{ me { id } }');
    expect(codes(r)).toEqual(['UNAUTHENTICATED']);
  });

  it('token inválido o expirado → UNAUTHENTICATED, incluso en operaciones públicas', async () => {
    const expired = await signToken(keys, ALICE, { expiresIn: Math.floor(Date.now() / 1000) - 10 });
    expect(codes(await app.gql('{ me { id } }', {}, { token: expired }))).toEqual([
      'UNAUTHENTICATED',
    ]);
    const r = await app.gql('{ problems { items { id } } }', {}, { token: 'basura' });
    expect(codes(r)).toEqual(['UNAUTHENTICATED']);
    const wrongAud = await signToken(keys, ALICE, { audience: 'otro' });
    expect(codes(await app.gql('{ me { id } }', {}, { token: wrongAud }))).toEqual([
      'UNAUTHENTICATED',
    ]);
  });

  it('me devuelve el usuario con email y propaga el token crudo y x-request-id', async () => {
    const r = await app.gql(
      '{ me { id username email role createdAt } }',
      {},
      { token: alice, headers: { 'x-request-id': 'req-abc' } },
    );
    expect(r.errors).toBeUndefined();
    expect(r.data).toEqual({
      me: {
        id: ALICE.sub,
        username: 'alice',
        email: 'alice@juez.test',
        role: 'CONTESTANT',
        createdAt: '2026-11-01T10:00:00.000Z',
      },
    });
    expect(backend.users.getUser).toHaveBeenCalledWith(
      { id: ALICE.sub },
      { token: alice, requestId: 'req-abc' },
    );
  });

  it('user ajeno no muestra el email; ADMIN sí; inexistente → null', async () => {
    const r = await app.gql(
      'query($id: ID!) { user(id: $id) { id email } }',
      { id: BOB.sub },
      {
        token: alice,
      },
    );
    expect(r.data).toEqual({ user: { id: BOB.sub, email: null } });
    const asAdmin = await app.gql(
      'query($id: ID!) { user(id: $id) { email } }',
      { id: BOB.sub },
      {
        token: admin,
      },
    );
    expect(asAdmin.data).toEqual({ user: { email: 'alice@juez.test' } });

    backend.users.getUser.mockRejectedValueOnce(upstreamError('users', GrpcStatus.NOT_FOUND));
    const missing = await app.gql(
      'query($id: ID!) { user(id: $id) { id } }',
      { id: BOB.sub },
      {
        token: alice,
      },
    );
    expect(missing.errors).toBeUndefined();
    expect(missing.data).toEqual({ user: null });
  });

  it('register llama a Register y después a Login, sin token en la metadata', async () => {
    const r = await app.gql(
      `mutation($i: RegisterInput!) { register(input: $i) { token expiresAt user { id username email } } }`,
      { i: { username: 'carol', email: 'carol@x.cl', password: 'secreta123' } },
    );
    expect(r.errors).toBeUndefined();
    expect(r.data).toMatchObject({
      register: { token: 'jwt-de-login', expiresAt: '2026-11-22T16:00:00.000Z' },
    });
    expect(backend.users.register).toHaveBeenCalledWith(
      { username: 'carol', email: 'carol@x.cl', password: 'secreta123' },
      { requestId: expect.any(String) },
    );
    expect(backend.users.login).toHaveBeenCalledWith(
      { usernameOrEmail: 'carol', password: 'secreta123' },
      { requestId: expect.any(String) },
    );
    expect(backend.users.register.mock.invocationCallOrder[0]).toBeLessThan(
      backend.users.login.mock.invocationCallOrder[0]!,
    );
  });

  it('register con username repetido → CONFLICT (y no intenta Login)', async () => {
    backend.users.register.mockRejectedValueOnce(
      upstreamError('users', GrpcStatus.ALREADY_EXISTS, 'el username ya existe'),
    );
    const r = await app.gql(
      `mutation { register(input: {username: "a", email: "a@a.cl", password: "12345678"}) { token } }`,
    );
    expect(codes(r)).toEqual(['CONFLICT']);
    expect(r.errors?.[0]?.message).toBe('el username ya existe');
    expect(backend.users.login).not.toHaveBeenCalled();
  });

  it('login con credenciales incorrectas → UNAUTHENTICATED', async () => {
    backend.users.login.mockRejectedValueOnce(
      upstreamError('users', GrpcStatus.UNAUTHENTICATED, 'credenciales inválidas'),
    );
    const r = await app.gql(
      `mutation { login(input: {usernameOrEmail: "a", password: "x"}) { token } }`,
    );
    expect(codes(r)).toEqual(['UNAUTHENTICATED']);
  });
});

describe('problemas', () => {
  it('catálogo público con filtros traducidos al proto', async () => {
    const r = await app.gql(
      `{ problems(filter: {tags: ["math"], difficulty: HARD}, pageSize: 5, pageToken: "t") {
          items { id slug difficulty tags published } nextPageToken } }`,
    );
    expect(r.errors).toBeUndefined();
    expect(r.data).toEqual({
      problems: {
        items: [
          { id: PROBLEM_ID, slug: 'suma', difficulty: 'EASY', tags: ['math'], published: true },
        ],
        nextPageToken: null,
      },
    });
    expect(backend.problems.listProblems).toHaveBeenCalledWith(
      { pageSize: 5, pageToken: 't', tags: ['math'], difficulty: 3 },
      { token: undefined, requestId: expect.any(String) },
    );
  });

  it('problem: exactamente uno de id o slug', async () => {
    const both = await app.gql(`{ problem(id: "x", slug: "y") { id } }`);
    expect(codes(both)).toEqual(['BAD_USER_INPUT']);
    const none = await app.gql(`{ problem { id } }`);
    expect(codes(none)).toEqual(['BAD_USER_INPUT']);
    const bySlug = await app.gql(`{ problem(slug: "suma") { slug examples { explanation } } }`);
    expect(bySlug.data).toEqual({ problem: { slug: 'suma', examples: [{ explanation: null }] } });
    expect(backend.problems.getProblem).toHaveBeenCalledWith({ slug: 'suma' }, expect.anything());
  });

  it('problem NOT_FOUND → null; UNAVAILABLE → error con mensaje claro', async () => {
    backend.problems.getProblem.mockRejectedValueOnce(
      upstreamError('problems', GrpcStatus.NOT_FOUND),
    );
    const nf = await app.gql(`{ problem(id: "x") { id } }`);
    expect(nf.errors).toBeUndefined();
    expect(nf.data).toEqual({ problem: null });

    backend.problems.getProblem.mockRejectedValueOnce(
      upstreamError('problems', GrpcStatus.UNAVAILABLE),
    );
    const down = await app.gql(`{ problem(id: "x") { id } }`);
    expect(codes(down)).toEqual(['UNAVAILABLE']);
    expect(down.errors?.[0]?.message).toMatch(/servicio de problemas no responde/);

    backend.problems.getProblem.mockRejectedValueOnce(
      upstreamError('problems', GrpcStatus.DEADLINE_EXCEEDED),
    );
    expect(codes(await app.gql(`{ problem(id: "x") { id } }`))).toEqual(['UNAVAILABLE']);
  });

  it('createProblem exige SETTER/ADMIN y aplica valores por defecto', async () => {
    const q = `mutation { createProblem(input: {title: "T", statement: "S", difficulty: MEDIUM}) { id published } }`;
    expect(codes(await app.gql(q, {}, { token: alice }))).toEqual(['FORBIDDEN']);
    const r = await app.gql(q, {}, { token: setter });
    expect(r.data).toEqual({ createProblem: { id: PROBLEM_ID, published: false } });
    expect(backend.problems.createProblem).toHaveBeenCalledWith(
      {
        slug: '',
        title: 'T',
        statement: 'S',
        difficulty: 2,
        tags: [],
        timeLimitMs: 0,
        memoryLimitMb: 0,
        examples: [],
      },
      { token: setter, requestId: expect.any(String) },
    );
  });

  it('updateProblem: solo los campos presentes; tags/examples reemplazan la lista', async () => {
    const r = await app.gql(
      `mutation { updateProblem(id: "p1", input: {title: "Nuevo", tags: [], published: true}) { id } }`,
      {},
      { token: setter },
    );
    expect(r.errors).toBeUndefined();
    expect(backend.problems.updateProblem).toHaveBeenCalledWith(
      {
        id: 'p1',
        title: 'Nuevo',
        statement: undefined,
        difficulty: 0,
        timeLimitMs: undefined,
        memoryLimitMb: undefined,
        tags: { values: [] },
        examples: undefined,
        published: true,
      },
      expect.anything(),
    );
  });

  it('updateProblem de otro autor → FORBIDDEN (lo decide problems)', async () => {
    backend.problems.updateProblem.mockRejectedValueOnce(
      upstreamError('problems', GrpcStatus.PERMISSION_DENIED, 'no eres el autor'),
    );
    const r = await app.gql(
      `mutation { updateProblem(id: "p1", input: {title: "x"}) { id } }`,
      {},
      { token: setter },
    );
    expect(codes(r)).toEqual(['FORBIDDEN']);
  });

  it('createTestcaseUploadUrl devuelve las URLs y el ordinal', async () => {
    const r = await app.gql(
      `mutation { createTestcaseUploadUrl(problemId: "p1", ordinal: 2) { testcaseId ordinal inputUploadUrl outputUploadUrl expiresAt } }`,
      {},
      { token: setter },
    );
    expect(r.data).toEqual({
      createTestcaseUploadUrl: {
        testcaseId: 'tc-1',
        ordinal: 2,
        inputUploadUrl: 'http://minio/in',
        outputUploadUrl: 'http://minio/out',
        expiresAt: '2026-11-22T15:15:00.000Z',
      },
    });
  });
});

describe('submissions y relaciones', () => {
  const LIST = `{ submissions(filter: {problemId: "${PROBLEM_ID}"}) {
      items { id verdict timeMs judgedAt sourceCode user { id username } problem { id title } contest { id title } }
      nextPageToken } }`;

  it('submit traduce el lenguaje y el contest', async () => {
    const r = await app.gql(
      `mutation($i: SubmitInput!) { submit(input: $i) { id verdict sourceCode timeMs judgedAt } }`,
      {
        i: {
          problemId: PROBLEM_ID,
          language: 'PYTHON3',
          sourceCode: 'print(1)',
          contestId: CONTEST_ID,
        },
      },
      { token: alice },
    );
    expect(r.data).toEqual({
      submit: {
        id: SUBMISSION_ID,
        verdict: 'PENDING',
        sourceCode: 'int main(){}',
        timeMs: null,
        judgedAt: null,
      },
    });
    expect(backend.submissions.createSubmission).toHaveBeenCalledWith(
      { problemId: PROBLEM_ID, language: 2, sourceCode: 'print(1)', contestId: CONTEST_ID },
      { token: alice, requestId: expect.any(String) },
    );
  });

  it('submit a un contest que no está en curso → BAD_USER_INPUT', async () => {
    backend.submissions.createSubmission.mockRejectedValueOnce(
      upstreamError('submissions', GrpcStatus.FAILED_PRECONDITION, 'el contest no está en curso'),
    );
    const r = await app.gql(
      `mutation { submit(input: {problemId: "p", language: CPP17, sourceCode: "x"}) { id } }`,
      {},
      { token: alice },
    );
    expect(codes(r)).toEqual(['BAD_USER_INPUT']);
    expect(r.errors?.[0]?.message).toBe('el contest no está en curso');
  });

  it('listado: relaciones resueltas con DataLoader (un GetUsers, problemas deduplicados)', async () => {
    backend.submissions.listSubmissions.mockResolvedValueOnce({
      submissions: [
        sampleSubmission({ id: 's1', userId: ALICE.sub, contestId: CONTEST_ID }),
        sampleSubmission({ id: 's2', userId: BOB.sub, contestId: CONTEST_ID }),
        sampleSubmission({ id: 's3', userId: ALICE.sub, problemId: PROBLEM_2_ID }),
        sampleSubmission({
          id: 's4',
          userId: BOB.sub,
          verdict: common.Verdict.VERDICT_ACCEPTED,
          timeMs: 15,
          judgedAt: ts('2026-11-22T15:00:03.000Z'),
        }),
      ],
      nextPageToken: 'n2',
    });
    const r = await app.gql(LIST, {}, { token: alice });
    expect(r.errors).toBeUndefined();
    const page = (
      r.data as { submissions: { items: Array<Record<string, unknown>>; nextPageToken: string } }
    ).submissions;
    expect(page.nextPageToken).toBe('n2');
    expect(page.items).toHaveLength(4);
    expect(page.items[0]).toMatchObject({
      sourceCode: null,
      user: { id: ALICE.sub },
      problem: { id: PROBLEM_ID },
      contest: { id: CONTEST_ID },
    });
    expect(page.items[3]).toMatchObject({
      verdict: 'ACCEPTED',
      timeMs: 15,
      judgedAt: '2026-11-22T15:00:03.000Z',
    });
    expect(backend.users.getUsers).toHaveBeenCalledTimes(1);
    expect(backend.users.getUsers.mock.calls[0]![0].ids.sort()).toEqual(
      [ALICE.sub, BOB.sub].sort(),
    );
    expect(backend.problems.getProblem).toHaveBeenCalledTimes(2);
    expect(backend.ranking.getContest).toHaveBeenCalledTimes(1);
    expect(backend.submissions.listSubmissions).toHaveBeenCalledWith(
      {
        pageSize: 0,
        pageToken: '',
        userId: undefined,
        problemId: PROBLEM_ID,
        contestId: undefined,
      },
      expect.anything(),
    );
  });

  it('relaciones nullable: si users/problems/ranking fallan, el campo queda en null sin errores', async () => {
    backend.submissions.listSubmissions.mockResolvedValueOnce({
      submissions: [sampleSubmission({ contestId: CONTEST_ID })],
      nextPageToken: '',
    });
    backend.users.getUsers.mockRejectedValueOnce(upstreamError('users', GrpcStatus.UNAVAILABLE));
    backend.problems.getProblem.mockRejectedValueOnce(
      upstreamError('problems', GrpcStatus.PERMISSION_DENIED),
    );
    backend.ranking.getContest.mockRejectedValueOnce(
      upstreamError('ranking', GrpcStatus.DEADLINE_EXCEEDED),
    );
    const r = await app.gql(LIST, {}, { token: alice });
    expect(r.errors).toBeUndefined();
    expect(r.data).toMatchObject({
      submissions: { items: [{ id: SUBMISSION_ID, user: null, problem: null, contest: null }] },
    });
  });

  it('usuario que GetUsers omite (no existe) → user null', async () => {
    backend.users.getUsers.mockResolvedValueOnce({ users: [] });
    const r = await app.gql(LIST, {}, { token: alice });
    expect(r.data).toMatchObject({ submissions: { items: [{ user: null }] } });
  });

  it('submission: sourceCode solo para el dueño o ADMIN; inexistente → null', async () => {
    const q = `query($id: ID!) { submission(id: $id) { id sourceCode } }`;
    expect((await app.gql(q, { id: SUBMISSION_ID }, { token: alice })).data).toEqual({
      submission: { id: SUBMISSION_ID, sourceCode: 'int main(){}' },
    });
    expect((await app.gql(q, { id: SUBMISSION_ID }, { token: bob })).data).toEqual({
      submission: { id: SUBMISSION_ID, sourceCode: null },
    });
    expect((await app.gql(q, { id: SUBMISSION_ID }, { token: admin })).data).toEqual({
      submission: { id: SUBMISSION_ID, sourceCode: 'int main(){}' },
    });
    backend.submissions.getSubmission.mockRejectedValueOnce(
      upstreamError('submissions', GrpcStatus.NOT_FOUND),
    );
    const nf = await app.gql(q, { id: 'x' }, { token: alice });
    expect(nf.errors).toBeUndefined();
    expect(nf.data).toEqual({ submission: null });
  });

  it('submissions sin sesión → UNAUTHENTICATED', async () => {
    expect(codes(await app.gql(LIST))).toEqual(['UNAUTHENTICATED']);
  });
});

describe('contests, scoreboard y estadísticas', () => {
  it('contest con letras y problemas (null si no se puede ver)', async () => {
    backend.problems.getProblem.mockImplementation(async (req) => {
      if (req.id === PROBLEM_2_ID) throw upstreamError('problems', GrpcStatus.NOT_FOUND);
      return { problem: sampleProblem({ id: req.id ?? '' }) };
    });
    const r = await app.gql(
      `query($id: ID!) { contest(id: $id) { id status startTime endTime createdById problems { letter problemId problem { id } } } }`,
      { id: CONTEST_ID },
      { token: alice },
    );
    expect(r.errors).toBeUndefined();
    expect(r.data).toEqual({
      contest: {
        id: CONTEST_ID,
        status: 'RUNNING',
        startTime: '2026-11-22T14:00:00.000Z',
        endTime: '2026-11-22T19:00:00.000Z',
        createdById: SETTER.sub,
        problems: [
          { letter: 'A', problemId: PROBLEM_ID, problem: { id: PROBLEM_ID } },
          { letter: 'B', problemId: PROBLEM_2_ID, problem: null },
        ],
      },
    });
  });

  it('contest: problems caído → ContestProblem.problem null sin romper la respuesta', async () => {
    backend.problems.getProblem.mockRejectedValue(
      upstreamError('problems', GrpcStatus.UNAVAILABLE),
    );
    const r = await app.gql(
      `{ contest(id: "${CONTEST_ID}") { title problems { letter problem { id } } } }`,
      {},
      { token: alice },
    );
    expect(r.errors).toBeUndefined();
    expect(r.data).toEqual({
      contest: {
        title: 'Contest 1',
        problems: [
          { letter: 'A', problem: null },
          { letter: 'B', problem: null },
        ],
      },
    });
  });

  it('contest inexistente → null; contests filtra por estado', async () => {
    backend.ranking.getContest.mockRejectedValueOnce(
      upstreamError('ranking', GrpcStatus.NOT_FOUND),
    );
    expect((await app.gql(`{ contest(id: "x") { id } }`, {}, { token: alice })).data).toEqual({
      contest: null,
    });
    const r = await app.gql(
      `{ contests(status: FINISHED, pageSize: 2) { items { id } nextPageToken } }`,
      {},
      { token: alice },
    );
    expect(r.data).toEqual({ contests: { items: [{ id: CONTEST_ID }], nextPageToken: 'next' } });
    expect(backend.ranking.listContests).toHaveBeenCalledWith(
      { pageSize: 2, pageToken: '', status: 3 },
      expect.anything(),
    );
  });

  it('scoreboard: letras, nulls sin resolver y username por defecto', async () => {
    backend.ranking.getScoreboard.mockResolvedValueOnce({
      contestId: CONTEST_ID,
      rows: [
        {
          rank: 1,
          userId: ALICE.sub,
          username: '',
          solved: 1,
          penaltyMinutes: 25,
          problems: [
            {
              problemId: PROBLEM_ID,
              solved: true,
              attempts: 2,
              solvedAtMinute: 5,
              penaltyMinutes: 25,
              firstToSolve: true,
            },
            {
              problemId: PROBLEM_2_ID,
              solved: false,
              attempts: 1,
              solvedAtMinute: 0,
              penaltyMinutes: 0,
              firstToSolve: false,
            },
          ],
        },
      ],
      nextPageToken: '',
      updatedAt: ts('2026-11-22T15:00:00.000Z'),
    });
    const r = await app.gql(
      `{ scoreboard(contestId: "${CONTEST_ID}") { contestId updatedAt nextPageToken items { rank username solved penaltyMinutes problems { letter solved attempts solvedAtMinute penaltyMinutes firstToSolve } } } }`,
      {},
      { token: alice },
    );
    expect(r.data).toEqual({
      scoreboard: {
        contestId: CONTEST_ID,
        updatedAt: '2026-11-22T15:00:00.000Z',
        nextPageToken: null,
        items: [
          {
            rank: 1,
            username: ALICE.sub,
            solved: 1,
            penaltyMinutes: 25,
            problems: [
              {
                letter: 'A',
                solved: true,
                attempts: 2,
                solvedAtMinute: 5,
                penaltyMinutes: 25,
                firstToSolve: true,
              },
              {
                letter: 'B',
                solved: false,
                attempts: 1,
                solvedAtMinute: null,
                penaltyMinutes: null,
                firstToSolve: false,
              },
            ],
          },
        ],
      },
    });
  });

  it('userStats sin userId pide las propias', async () => {
    backend.ranking.getUserStats.mockResolvedValueOnce({
      userId: ALICE.sub,
      username: 'alice',
      solvedCount: 1,
      attemptedCount: 2,
      totalSubmissions: 3,
      verdictCounts: [{ verdict: common.Verdict.VERDICT_WRONG_ANSWER, count: 2 }],
      solvedProblemIds: [PROBLEM_ID],
    });
    const r = await app.gql(
      `{ userStats { userId solvedCount verdictCounts { verdict count } solvedProblemIds } }`,
      {},
      { token: alice },
    );
    expect(r.data).toEqual({
      userStats: {
        userId: ALICE.sub,
        solvedCount: 1,
        verdictCounts: [{ verdict: 'WRONG_ANSWER', count: 2 }],
        solvedProblemIds: [PROBLEM_ID],
      },
    });
    expect(backend.ranking.getUserStats).toHaveBeenCalledWith({ userId: '' }, expect.anything());
  });

  it('createContest convierte fechas con offset a Timestamp y exige SETTER/ADMIN', async () => {
    const q = `mutation($i: CreateContestInput!) { createContest(input: $i) { id } }`;
    const input = {
      title: 'C',
      startTime: '2026-11-23T10:00:00-03:00',
      endTime: '2026-11-23T15:00:00.500Z',
      problemIds: [PROBLEM_ID],
    };
    expect(codes(await app.gql(q, { i: input }, { token: alice }))).toEqual(['FORBIDDEN']);
    const r = await app.gql(q, { i: input }, { token: admin });
    expect(r.errors).toBeUndefined();
    expect(backend.ranking.createContest).toHaveBeenCalledWith(
      {
        title: 'C',
        description: '',
        startTime: { seconds: Date.parse('2026-11-23T13:00:00Z') / 1000, nanos: 0 },
        endTime: { seconds: Date.parse('2026-11-23T15:00:00Z') / 1000, nanos: 500_000_000 },
        problemIds: [PROBLEM_ID],
      },
      expect.anything(),
    );
  });

  it('DateTime inválido → error de validación de variables', async () => {
    const r = await app.gql(
      `mutation($i: CreateContestInput!) { createContest(input: $i) { id } }`,
      { i: { title: 'C', startTime: 'mañana', endTime: '2026-11-23T15:00:00Z', problemIds: [] } },
      { token: admin },
    );
    expect(codes(r)).toEqual(['BAD_USER_INPUT']);
    expect(backend.ranking.createContest).not.toHaveBeenCalled();
  });
});

describe('asistente', () => {
  it('askAssistant exige sesión y pasa el token crudo al servicio', async () => {
    expect(codes(await app.gql(`mutation { askAssistant(message: "hola") { message } }`))).toEqual([
      'UNAUTHENTICATED',
    ]);
    const r = await app.gql(
      `mutation { askAssistant(message: "hola", history: [{role: USER, content: "a"}]) { message toolCalls { name } } }`,
      {},
      { token: alice, headers: { 'x-request-id': 'r-1' } },
    );
    expect(r.data).toEqual({ askAssistant: { message: 'hola', toolCalls: [] } });
    expect(app.assistant.ask).toHaveBeenCalledWith({
      userId: ALICE.sub,
      token: alice,
      requestId: 'r-1',
      message: 'hola',
      history: [{ role: 'USER', content: 'a' }],
    });
  });
});

describe('seguridad y operación', () => {
  it('rechaza queries demasiado profundas', async () => {
    const deep = `{ submissions { items { contest { problems { problem { id } } } } } }`;
    expect((await app.gql(deep, {}, { token: alice })).errors).toBeUndefined();
    const tooDeep = `{ a: submissions { items { contest { problems { problem { tags } } } } } }`;
    const app2 = await startTestApp(keys, { env: { BFF_GRAPHQL_MAX_DEPTH: '4' } });
    try {
      const r = await app2.gql(tooDeep, {}, { token: alice });
      expect(codes(r)).toEqual(['GRAPHQL_VALIDATION_FAILED']);
      expect(r.errors?.[0]?.message).toMatch(/profundidad 6; el máximo es 4/);
    } finally {
      await app2.close();
    }
  });

  it('introspección habilitada fuera de producción', async () => {
    const r = await app.gql(`{ __schema { queryType { name } } }`);
    expect(r.data).toEqual({ __schema: { queryType: { name: 'Query' } } });
  });

  it('en producción no hay introspección y los errores inesperados no filtran detalles', async () => {
    const prod = await startTestApp(keys, { env: { NODE_ENV: 'production' } });
    try {
      const r = await prod.gql(`{ __schema { queryType { name } } }`);
      expect(codes(r)).toEqual(['GRAPHQL_VALIDATION_FAILED']);
      prod.backend.users.getUser.mockRejectedValueOnce(new TypeError('secreto interno'));
      const token = await signToken(keys, ALICE);
      const boom = await prod.gql(`{ me { id } }`, {}, { token });
      expect(codes(boom)).toEqual(['INTERNAL_SERVER_ERROR']);
      expect(boom.errors?.[0]?.message).toBe('Error interno del servidor.');
      expect(JSON.stringify(boom)).not.toContain('secreto');
    } finally {
      await prod.close();
    }
  });

  it('CORS: responde al origen configurado', async () => {
    const res = await fetch(`${app.url}/graphql`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,authorization',
      },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    const other = await fetch(`${app.url}/graphql`, {
      method: 'OPTIONS',
      headers: { origin: 'http://evil.test', 'access-control-request-method': 'POST' },
    });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('/health siempre 200; /ready depende de la llave y del consumidor; /metrics', async () => {
    expect((await fetch(`${app.url}/health`)).status).toBe(200);
    await app.verifier.init();
    const ready = await fetch(`${app.url}/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ status: 'ready' });

    app.consumer.readiness.status.mockReturnValueOnce({
      joined: false,
      crashed: false,
      ready: false,
    });
    const notReady = await fetch(`${app.url}/ready`);
    expect(notReady.status).toBe(503);
    expect(await notReady.json()).toMatchObject({
      status: 'not_ready',
      checks: { judgedConsumer: { status: 'down' } },
    });

    const metrics = await fetch(`${app.url}/metrics`);
    expect(metrics.status).toBe(200);
    expect(await metrics.text()).toContain('events_processed_total');
  });

  it('/ready 503 mientras no hay llave pública (users caído)', async () => {
    const b = fakeBackend(keys);
    b.users.getPublicKey.mockRejectedValue(upstreamError('users', GrpcStatus.UNAVAILABLE));
    const down = await startTestApp(keys, { backend: b, consumer: fakeConsumer(true) });
    try {
      const res = await fetch(`${down.url}/ready`);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ checks: { jwtPublicKey: { status: 'down' } } });
      // Una operación autenticada informa UNAVAILABLE (no UNAUTHENTICATED).
      const r = await down.gql(`{ me { id } }`, {}, { token: alice });
      expect(codes(r)).toEqual(['UNAVAILABLE']);
    } finally {
      await down.close();
    }
  });

  it('sin Gemini, askAssistant responde ASSISTANT_DISABLED y el resto funciona', async () => {
    const disabled = await startTestApp(keys, {
      assistant: new AssistantService({
        model: undefined,
        mcp: { connect: vi.fn() },
        logger: silentLogger,
        maxRounds: 5,
        timeoutMs: 1000,
        rateLimitPerMinute: 10,
      }),
    });
    try {
      const r = await disabled.gql(
        `mutation { askAssistant(message: "hola") { message } }`,
        {},
        { token: alice },
      );
      expect(codes(r)).toEqual(['ASSISTANT_DISABLED']);
      const ok = await disabled.gql(`{ problems { items { id } } }`);
      expect(ok.errors).toBeUndefined();
    } finally {
      await disabled.close();
    }
  });
});

describe('logs', () => {
  it('los errores GraphQL esperados no se registran como error de Nest', async () => {
    const lines: string[] = [];
    const { pino } = await import('pino');
    const logger = pino({ level: 'info' }, { write: (l: string) => void lines.push(l) });
    const { createApp } = await import('./app.js');
    const { testConfig, fakeConsumer: fc } = await import('./test-utils/fixtures.js');
    const { PubSub } = await import('./events/pubsub.js');
    const { createMetrics } = await import('./metrics.js');
    const { JwtVerifier } = await import('./auth/jwt-verifier.js');
    const b = fakeBackend(keys);
    b.problems.getProblem.mockRejectedValue(upstreamError('problems', GrpcStatus.UNAVAILABLE));
    const nest = await createApp({
      config: testConfig(),
      logger,
      metrics: createMetrics({ defaultMetrics: false }),
      backend: b as never,
      verifier: new JwtVerifier(b.users as never, 'juez-users', 'juez', silentLogger),
      pubsub: new PubSub(),
      assistant: { ask: vi.fn() },
      consumer: fc(false),
    });
    await nest.listen(0, '127.0.0.1');
    const port = (nest.getHttpServer().address() as { port: number }).port;
    try {
      const post = (query: string) =>
        fetch(`http://127.0.0.1:${port}/graphql`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query }),
        }).then((r) => r.json() as Promise<{ errors?: Array<{ extensions: { code: string } }> }>);
      expect((await post('{ me { id } }')).errors?.[0]?.extensions.code).toBe('UNAUTHENTICATED');
      expect((await post('{ problem(id: "x") { id } }')).errors?.[0]?.extensions.code).toBe(
        'UNAVAILABLE',
      );
      // El filtro global no rompe los controladores HTTP: /ready sigue respondiendo 503.
      expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(503);
      expect(lines.filter((l) => l.includes('ExceptionsHandler'))).toEqual([]);
    } finally {
      await nest.close();
    }
  });
});
