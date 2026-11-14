import { Code, ConnectError } from '@connectrpc/connect';
import { create } from '@bufbuild/protobuf';
import {
  CreateProblemRequestSchema,
  CreateTestcaseUploadUrlRequestSchema,
  Difficulty,
  GetProblemRequestSchema,
  ListProblemsRequestSchema,
  UpdateProblemRequestSchema,
} from '@juez/contracts/es';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '../auth/jwt.js';
import {
  FakeTestcaseStorage,
  InMemoryProblemsRepository,
  silentLogger,
} from '../test-utils/fakes.js';
import { testcaseKeys } from '../storage/testcase-storage.js';
import { ProblemCatalog } from './problem-catalog.js';

const AUTHOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const setter: Principal = { userId: AUTHOR, username: 'ana', role: 'SETTER' };
const otherSetter: Principal = {
  userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  username: 'otro',
  role: 'SETTER',
};
const admin: Principal = {
  userId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  username: 'root',
  role: 'ADMIN',
};
const contestant: Principal = {
  userId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  username: 'bob',
  role: 'CONTESTANT',
};

async function expectCode(promise: Promise<unknown>, code: Code): Promise<ConnectError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ConnectError);
  expect((err as ConnectError).code).toBe(code);
  return err as ConnectError;
}

describe('ProblemCatalog', () => {
  let repo: InMemoryProblemsRepository;
  let storage: FakeTestcaseStorage;
  let catalog: ProblemCatalog;
  let ids: number;

  beforeEach(() => {
    repo = new InMemoryProblemsRepository();
    storage = new FakeTestcaseStorage();
    ids = 0;
    catalog = new ProblemCatalog({
      repo,
      storage,
      logger: silentLogger,
      now: () => new Date('2026-11-11T10:00:00Z'),
      newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    });
  });

  describe('list', () => {
    beforeEach(() => {
      repo.add({
        id: '10000000-0000-4000-8000-000000000001',
        slug: 'p1',
        tags: ['dp', 'math'],
        difficulty: 'EASY',
      });
      repo.add({
        id: '10000000-0000-4000-8000-000000000002',
        slug: 'p2',
        tags: ['math'],
        published: false,
      });
      repo.add({
        id: '10000000-0000-4000-8000-000000000003',
        slug: 'p3',
        tags: ['dp'],
        difficulty: 'HARD',
      });
    });

    const req = (init: Parameters<typeof create<typeof ListProblemsRequestSchema>>[1] = {}) =>
      create(ListProblemsRequestSchema, init);

    it('anónimos y contestants solo ven publicados', async () => {
      expect((await catalog.list(req(), undefined)).problems.map((p) => p.slug)).toEqual([
        'p1',
        'p3',
      ]);
      expect((await catalog.list(req(), contestant)).problems.map((p) => p.slug)).toEqual([
        'p1',
        'p3',
      ]);
    });

    it('setters y admins ven todos', async () => {
      expect((await catalog.list(req(), setter)).problems).toHaveLength(3);
      expect((await catalog.list(req(), admin)).problems).toHaveLength(3);
    });

    it('filtra por todos los tags (normalizados) y por dificultad', async () => {
      const byTags = await catalog.list(req({ tags: [' DP', 'math'] }), setter);
      expect(byTags.problems.map((p) => p.slug)).toEqual(['p1']);
      const byDifficulty = await catalog.list(req({ difficulty: Difficulty.HARD }), setter);
      expect(byDifficulty.problems.map((p) => p.slug)).toEqual(['p3']);
    });

    it('pagina con un cursor opaco', async () => {
      const first = await catalog.list(req({ pageSize: 2 }), setter);
      expect(first.problems.map((p) => p.slug)).toEqual(['p1', 'p2']);
      expect(first.nextPageToken).not.toBe('');
      const second = await catalog.list(
        req({ pageSize: 2, pageToken: first.nextPageToken }),
        setter,
      );
      expect(second.problems.map((p) => p.slug)).toEqual(['p3']);
      expect(second.nextPageToken).toBe('');
    });

    it('rechaza page_token inválido', async () => {
      await expectCode(catalog.list(req({ pageToken: 'basura' }), setter), Code.InvalidArgument);
    });
  });

  describe('get', () => {
    it('busca por id o slug y cuenta solo los casos subidos', async () => {
      const p = repo.add({ id: '10000000-0000-4000-8000-000000000001', slug: 'p1' });
      repo.testcases.push(
        { id: 't1', problemId: p.id, ordinal: 1, uploadedAt: new Date() },
        { id: 't2', problemId: p.id, ordinal: 2, uploadedAt: null },
      );
      const byId = await catalog.get(
        create(GetProblemRequestSchema, { key: { case: 'id', value: p.id } }),
        undefined,
      );
      expect(byId.testcaseCount).toBe(1);
      const bySlug = await catalog.get(
        create(GetProblemRequestSchema, { key: { case: 'slug', value: 'p1' } }),
        undefined,
      );
      expect(bySlug.problem.id).toBe(p.id);
    });

    it('confirma de forma perezosa los casos ya subidos a S3', async () => {
      const p = repo.add({ id: '10000000-0000-4000-8000-000000000001' });
      repo.testcases.push({ id: 't1', problemId: p.id, ordinal: 1, uploadedAt: null });
      const keys = testcaseKeys(p.id, 1);
      storage.objects.set(keys.input, '1 2');
      storage.objects.set(keys.output, '3');
      const view = await catalog.get(
        create(GetProblemRequestSchema, { key: { case: 'id', value: p.id } }),
        undefined,
      );
      expect(view.testcaseCount).toBe(1);
      expect(repo.testcases[0]?.uploadedAt).toEqual(new Date('2026-11-11T10:00:00Z'));
    });

    it('si S3 falla en una lectura, responde con lo confirmado', async () => {
      const p = repo.add({ id: '10000000-0000-4000-8000-000000000001' });
      repo.testcases.push({ id: 't1', problemId: p.id, ordinal: 1, uploadedAt: null });
      storage.failExists = true;
      const view = await catalog.get(
        create(GetProblemRequestSchema, { key: { case: 'id', value: p.id } }),
        undefined,
      );
      expect(view.testcaseCount).toBe(0);
    });

    it('oculta problemas sin publicar a quien no es SETTER/ADMIN', async () => {
      const p = repo.add({ id: '10000000-0000-4000-8000-000000000001', published: false });
      const req = create(GetProblemRequestSchema, { key: { case: 'id', value: p.id } });
      await expectCode(catalog.get(req, contestant), Code.NotFound);
      await expectCode(catalog.get(req, undefined), Code.NotFound);
      expect((await catalog.get(req, otherSetter)).problem.id).toBe(p.id);
    });

    it('valida la clave', async () => {
      await expectCode(
        catalog.get(create(GetProblemRequestSchema), undefined),
        Code.InvalidArgument,
      );
      await expectCode(
        catalog.get(
          create(GetProblemRequestSchema, { key: { case: 'id', value: 'no-uuid' } }),
          undefined,
        ),
        Code.InvalidArgument,
      );
      await expectCode(
        catalog.get(
          create(GetProblemRequestSchema, { key: { case: 'slug', value: 'nada' } }),
          undefined,
        ),
        Code.NotFound,
      );
    });
  });

  describe('create', () => {
    const req = (init: Parameters<typeof create<typeof CreateProblemRequestSchema>>[1] = {}) =>
      create(CreateProblemRequestSchema, {
        title: 'Suma de Dos Números',
        difficulty: Difficulty.EASY,
        ...init,
      });

    it('requiere SETTER o ADMIN', async () => {
      await expectCode(catalog.create(req(), undefined), Code.Unauthenticated);
      await expectCode(catalog.create(req(), contestant), Code.PermissionDenied);
      expect((await catalog.create(req(), admin)).problem.authorId).toBe(admin.userId);
    });

    it('toma el autor del token, genera el slug y aplica defaults', async () => {
      const { problem, testcaseCount } = await catalog.create(req({ tags: ['DP', 'dp'] }), setter);
      expect(problem).toMatchObject({
        slug: 'suma-de-dos-numeros',
        authorId: AUTHOR,
        tags: ['dp'],
        timeLimitMs: 1000,
        memoryLimitMb: 256,
        published: false,
      });
      expect(testcaseCount).toBe(0);
    });

    it('resuelve colisiones del slug generado con sufijos', async () => {
      await catalog.create(req(), setter);
      await catalog.create(req(), setter);
      const third = await catalog.create(req(), setter);
      expect(third.problem.slug).toBe('suma-de-dos-numeros-3');
    });

    it('un slug explícito repetido es ALREADY_EXISTS', async () => {
      await catalog.create(req({ slug: 'mi-slug' }), setter);
      await expectCode(catalog.create(req({ slug: 'mi-slug' }), setter), Code.AlreadyExists);
    });

    it('se rinde tras muchas colisiones', async () => {
      for (let i = 1; i <= 20; i++) repo.add({ slug: i === 1 ? 'x' : `x-${i}` });
      await expectCode(catalog.create(req({ title: 'x' }), setter), Code.AlreadyExists);
    });

    it('propaga errores inesperados del repositorio', async () => {
      repo.insert = () => Promise.reject(new Error('db caída'));
      await expect(catalog.create(req(), setter)).rejects.toThrow('db caída');
    });

    it('valida los campos', async () => {
      await expectCode(catalog.create(req({ title: '  ' }), setter), Code.InvalidArgument);
      await expectCode(
        catalog.create(req({ difficulty: Difficulty.UNSPECIFIED }), setter),
        Code.InvalidArgument,
      );
      await expectCode(catalog.create(req({ slug: 'Con Espacios' }), setter), Code.InvalidArgument);
    });
  });

  describe('update', () => {
    const ID = '10000000-0000-4000-8000-000000000001';
    beforeEach(() => {
      repo.add({ id: ID, authorId: AUTHOR, published: false });
    });
    const req = (init: Parameters<typeof create<typeof UpdateProblemRequestSchema>>[1] = {}) =>
      create(UpdateProblemRequestSchema, { id: ID, ...init });

    it('el autor actualiza parcialmente', async () => {
      const { problem } = await catalog.update(
        req({
          title: 'Nuevo',
          published: true,
          tags: { values: ['Grafos'] },
          examples: { values: [] },
        }),
        setter,
      );
      expect(problem).toMatchObject({
        title: 'Nuevo',
        published: true,
        tags: ['grafos'],
        examples: [],
        statement: 'Suma',
      });
    });

    it('sin cambios devuelve el problema tal cual', async () => {
      const { problem } = await catalog.update(req(), setter);
      expect(problem.updatedAt).toEqual(new Date('2026-11-10T00:00:00Z'));
    });

    it('otro setter no puede; un admin sí', async () => {
      await expectCode(catalog.update(req({ title: 'x' }), otherSetter), Code.PermissionDenied);
      await expectCode(catalog.update(req({ title: 'x' }), contestant), Code.PermissionDenied);
      await expectCode(catalog.update(req({ title: 'x' }), undefined), Code.Unauthenticated);
      expect((await catalog.update(req({ title: 'x' }), admin)).problem.title).toBe('x');
    });

    it('NOT_FOUND si no existe o desaparece', async () => {
      await expectCode(
        catalog.update(req({ id: '10000000-0000-4000-8000-000000000009', title: 'x' }), admin),
        Code.NotFound,
      );
      repo.update = () => Promise.resolve(undefined);
      await expectCode(catalog.update(req({ title: 'x' }), admin), Code.NotFound);
    });
  });

  describe('createTestcaseUploadUrl', () => {
    const ID = '10000000-0000-4000-8000-000000000001';
    beforeEach(() => {
      repo.add({ id: ID, authorId: AUTHOR });
    });
    const req = (ordinal = 1, problemId = ID) =>
      create(CreateTestcaseUploadUrlRequestSchema, { problemId, ordinal });

    it('registra el caso y firma URLs PUT con el endpoint público', async () => {
      const urls = await catalog.createTestcaseUploadUrl(req(3), setter);
      expect(urls.inputUrl).toBe(`http://public:9000/PUT/problems/${ID}/3.in`);
      expect(urls.outputUrl).toBe(`http://public:9000/PUT/problems/${ID}/3.out`);
      expect(repo.testcases).toEqual([
        { id: urls.testcaseId, problemId: ID, ordinal: 3, uploadedAt: null },
      ]);
    });

    it('reutiliza el caso si el ordinal ya existe', async () => {
      const a = await catalog.createTestcaseUploadUrl(req(1), setter);
      const b = await catalog.createTestcaseUploadUrl(req(1), admin);
      expect(b.testcaseId).toBe(a.testcaseId);
      expect(repo.testcases).toHaveLength(1);
    });

    it('valida permisos, problema y ordinal', async () => {
      await expectCode(catalog.createTestcaseUploadUrl(req(), otherSetter), Code.PermissionDenied);
      await expectCode(catalog.createTestcaseUploadUrl(req(), contestant), Code.PermissionDenied);
      await expectCode(catalog.createTestcaseUploadUrl(req(0), setter), Code.InvalidArgument);
      await expectCode(
        catalog.createTestcaseUploadUrl(req(1, '10000000-0000-4000-8000-000000000009'), setter),
        Code.NotFound,
      );
    });
  });

  describe('judgeSpec', () => {
    const ID = '10000000-0000-4000-8000-000000000001';

    it('devuelve límites y URLs GET internas de los casos subidos, en orden', async () => {
      repo.add({ id: ID, timeLimitMs: 2000, memoryLimitMb: 128, published: false });
      repo.testcases.push(
        { id: 't2', problemId: ID, ordinal: 2, uploadedAt: new Date() },
        { id: 't1', problemId: ID, ordinal: 1, uploadedAt: null },
        { id: 't3', problemId: ID, ordinal: 3, uploadedAt: null },
      );
      const keys = testcaseKeys(ID, 1);
      storage.objects.set(keys.input, 'x');
      storage.objects.set(keys.output, 'y');

      const spec = await catalog.judgeSpec(ID);
      expect(spec.problem.timeLimitMs).toBe(2000);
      expect(spec.testcases.map((t) => [t.id, t.ordinal])).toEqual([
        ['t1', 1],
        ['t2', 2],
      ]);
      expect(spec.testcases[0]?.inputUrl).toBe(`http://minio:9000/GET/problems/${ID}/1.in`);
      expect(spec.urlsExpireAt).toEqual(new Date('2026-11-11T00:10:00Z'));
    });

    it('FAILED_PRECONDITION sin casos; NOT_FOUND sin problema; UNAVAILABLE si S3 falla', async () => {
      await expectCode(catalog.judgeSpec(ID), Code.NotFound);
      await expectCode(catalog.judgeSpec('x'), Code.InvalidArgument);
      repo.add({ id: ID });
      await expectCode(catalog.judgeSpec(ID), Code.FailedPrecondition);
      repo.testcases.push({ id: 't1', problemId: ID, ordinal: 1, uploadedAt: null });
      storage.failExists = true;
      await expectCode(catalog.judgeSpec(ID), Code.Unavailable);
    });
  });
});
