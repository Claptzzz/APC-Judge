import {
  Code,
  ConnectError,
  createClient,
  createRouterTransport,
  type Client,
} from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { Difficulty, ProblemService } from '@juez/contracts/es';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JwtVerifier } from '../auth/jwt.js';
import { ProblemCatalog } from '../domain/problem-catalog.js';
import { createMetrics } from '../metrics.js';
import { testcaseKeys } from '../storage/testcase-storage.js';
import {
  FakeTestcaseStorage,
  InMemoryProblemsRepository,
  silentLogger,
} from '../test-utils/fakes.js';
import { AUDIENCE, createTestKeys, ISSUER, signToken, type TestKeys } from '../test-utils/jwt.js';
import { observabilityInterceptor } from './interceptors.js';
import { createProblemServiceImpl } from './problem-service.js';
import { createGrpcServer, type GrpcServer } from './server.js';

const AUTHOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID = '10000000-0000-4000-8000-000000000001';

let keys: TestKeys;
beforeAll(async () => {
  keys = await createTestKeys();
});

function setup() {
  const repo = new InMemoryProblemsRepository();
  const storage = new FakeTestcaseStorage();
  const catalog = new ProblemCatalog({ repo, storage, logger: silentLogger });
  const verifier = new JwtVerifier(() => Promise.resolve(keys.info), {
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  const metrics = createMetrics({ defaultMetrics: false });
  const impl = createProblemServiceImpl(catalog, verifier);
  const interceptors = [observabilityInterceptor(silentLogger, metrics)];
  return { repo, storage, impl, interceptors, metrics };
}

const auth = async (role = 'SETTER', sub = AUTHOR) => ({
  headers: { authorization: `Bearer ${await signToken(keys, { role, sub })}` },
});

describe('ProblemService (router en memoria)', () => {
  let ctx: ReturnType<typeof setup>;
  let client: Client<typeof ProblemService>;

  beforeEach(() => {
    ctx = setup();
    const transport = createRouterTransport(({ service }) => service(ProblemService, ctx.impl), {
      router: { interceptors: ctx.interceptors },
    });
    client = createClient(ProblemService, transport);
  });

  it('lecturas públicas sin token', async () => {
    ctx.repo.add({ id: ID, slug: 'a-mas-b', tags: ['math'] });
    const list = await client.listProblems({});
    expect(list.problems.map((p) => [p.slug, p.difficulty, p.tags])).toEqual([
      ['a-mas-b', Difficulty.EASY, ['math']],
    ]);
    const { problem } = await client.getProblem({ key: { case: 'slug', value: 'a-mas-b' } });
    expect(problem?.id).toBe(ID);
    expect(timestampDate(problem!.createdAt!)).toEqual(new Date('2026-11-10T00:00:00Z'));
  });

  it('con token inválido falla aunque la RPC sea pública', async () => {
    await expect(
      client.listProblems({}, { headers: { authorization: 'Bearer basura' } }),
    ).rejects.toMatchObject({
      code: Code.Unauthenticated,
    });
  });

  it('create/update/upload con JWT de SETTER', async () => {
    const created = await client.createProblem(
      { title: 'Mi Problema', difficulty: Difficulty.HARD },
      await auth(),
    );
    expect(created.problem).toMatchObject({
      slug: 'mi-problema',
      authorId: AUTHOR,
      difficulty: Difficulty.HARD,
    });
    const id = created.problem!.id;

    const updated = await client.updateProblem(
      { id, published: true, timeLimitMs: 2000 },
      await auth(),
    );
    expect(updated.problem).toMatchObject({ published: true, timeLimitMs: 2000 });

    const upload = await client.createTestcaseUploadUrl(
      { problemId: id, ordinal: 1 },
      await auth(),
    );
    expect(upload.inputUploadUrl).toContain(`problems/${id}/1.in`);
    expect(upload.expiresAt).toBeDefined();
  });

  it('CONTESTANT no puede crear', async () => {
    await expect(
      client.createProblem({ title: 'x', difficulty: Difficulty.EASY }, await auth('CONTESTANT')),
    ).rejects.toMatchObject({ code: Code.PermissionDenied });
  });

  it('GetJudgeSpec no exige JWT', async () => {
    ctx.repo.add({ id: ID, memoryLimitMb: 64 });
    ctx.repo.testcases.push({ id: 't1', problemId: ID, ordinal: 1, uploadedAt: new Date() });
    const spec = await client.getJudgeSpec({ problemId: ID });
    expect(spec).toMatchObject({ problemId: ID, memoryLimitMb: 64, timeLimitMs: 1000 });
    expect(spec.testcases[0]).toMatchObject({ id: 't1', ordinal: 1 });
    expect(spec.urlsExpireAt).toBeDefined();
  });

  it('errores no controlados salen como INTERNAL genérico y se cuentan en métricas', async () => {
    ctx.repo.list = () => Promise.reject(new Error('detalle interno'));
    const err = await client.listProblems({}).catch((e: unknown) => ConnectError.from(e));
    expect(err).toMatchObject({ code: Code.Internal, rawMessage: 'error interno' });
    const metrics = await ctx.metrics.registry.getMetricsAsJSON();
    const handled = metrics.find((m) => m.name === 'grpc_server_handled_total');
    expect(JSON.stringify(handled)).toContain('Internal');
  });
});

describe('servidor gRPC HTTP/2', () => {
  let server: GrpcServer;
  let client: Client<typeof ProblemService>;
  let ctx: ReturnType<typeof setup>;

  beforeAll(async () => {
    ctx = setup();
    server = createGrpcServer(ctx.impl, ctx.interceptors);
    const port = await server.listen(0, '127.0.0.1');
    client = createClient(
      ProblemService,
      createGrpcTransport({ baseUrl: `http://127.0.0.1:${port}` }),
    );
  });

  afterAll(() => server.close(1_000));

  it('atiende gRPC sobre h2c y devuelve x-request-id', async () => {
    ctx.repo.add({ id: ID, slug: 'p' });
    const keys2 = testcaseKeys(ID, 1);
    ctx.storage.objects.set(keys2.input, '1');
    ctx.storage.objects.set(keys2.output, '1');
    let header: Headers | undefined;
    const res = await client.getProblem(
      { key: { case: 'id', value: ID } },
      { headers: { 'x-request-id': 'req-123' }, onHeader: (h) => (header = h) },
    );
    expect(res.problem?.slug).toBe('p');
    expect(header?.get('x-request-id')).toBe('req-123');
  });

  it('genera x-request-id si no viene o es inválido, también en errores', async () => {
    const err = await client
      .getProblem(
        { key: { case: 'slug', value: 'nada' } },
        { headers: { 'x-request-id': 'con espacios' } },
      )
      .then(
        () => new ConnectError('se esperaba un error'),
        (e: unknown) => ConnectError.from(e),
      );
    expect(err.code).toBe(Code.NotFound);
    expect(err.metadata.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('close() termina aunque no esté escuchando', async () => {
    const idle = createGrpcServer(ctx.impl, []);
    await expect(idle.close()).resolves.toBeUndefined();
  });
});
