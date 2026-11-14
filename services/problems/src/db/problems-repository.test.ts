import { describe, expect, it } from 'vitest';
import { createFakeDb } from '../test-utils/fakes.js';
import { migrateToLatest, pingDb } from './database.js';
import {
  isSlugUniqueViolation,
  KyselyProblemsRepository,
  SlugTakenError,
  toProblemRowUpdate,
} from './problems-repository.js';

const ID = '10000000-0000-4000-8000-000000000001';
const row = {
  id: ID,
  seq: '7',
  slug: 'a-mas-b',
  title: 'A + B',
  statement: '',
  difficulty: 'EASY',
  tags: ['math'],
  time_limit_ms: 1000,
  memory_limit_mb: 256,
  examples: [{ input: '1 2', output: '3', explanation: '' }],
  published: true,
  author_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  created_at: new Date('2026-11-10T00:00:00Z'),
  updated_at: new Date('2026-11-10T00:00:00Z'),
};

describe('KyselyProblemsRepository', () => {
  it('list arma filtros, cursor y orden', async () => {
    const { db, queries } = createFakeDb(() => [row]);
    const repo = new KyselyProblemsRepository(db);
    const result = await repo.list({
      tags: ['dp', 'math'],
      difficulty: 'EASY',
      publishedOnly: true,
      afterSeq: '5',
      limit: 21,
    });
    expect(result[0]).toMatchObject({
      id: ID,
      seq: '7',
      timeLimitMs: 1000,
      authorId: row.author_id,
    });
    const q = queries[0]!;
    expect(q.sql).toContain('"published" = $1');
    expect(q.sql).toContain('"difficulty" = $2');
    expect(q.sql).toContain('tags @> $3::text[]');
    expect(q.sql).toContain('"seq" > $4');
    expect(q.sql).toMatch(/order by "seq" asc limit \$5$/);
    expect(q.parameters).toEqual([true, 'EASY', ['dp', 'math'], '5', 21]);
  });

  it('list sin filtros', async () => {
    const { db, queries } = createFakeDb(() => []);
    await new KyselyProblemsRepository(db).list({ tags: [], publishedOnly: false, limit: 10 });
    expect(queries[0]!.sql).toBe('select * from "problems" order by "seq" asc limit $1');
  });

  it('findById / findBySlug', async () => {
    const { db, queries } = createFakeDb((q) => (q.parameters[0] === ID ? [row] : []));
    const repo = new KyselyProblemsRepository(db);
    expect((await repo.findById(ID))?.slug).toBe('a-mas-b');
    expect(await repo.findBySlug('nada')).toBeUndefined();
    expect(queries[1]!.sql).toContain('where "slug" = $1');
  });

  it('insert serializa examples y traduce la violación de unicidad del slug', async () => {
    const { db, queries } = createFakeDb(() => [row]);
    const repo = new KyselyProblemsRepository(db);
    const p = await repo.insert({
      id: ID,
      slug: 'a-mas-b',
      title: 'A + B',
      statement: '',
      difficulty: 'EASY',
      tags: ['math'],
      timeLimitMs: 1000,
      memoryLimitMb: 256,
      examples: [{ input: '1 2', output: '3', explanation: '' }],
      authorId: row.author_id,
    });
    expect(p.examples).toEqual(row.examples);
    expect(queries[0]!.sql).toMatch(/^insert into "problems"/);
    expect(queries[0]!.parameters).toContain(JSON.stringify(row.examples));

    const dup = createFakeDb(() =>
      Object.assign(new Error('dup'), { code: '23505', constraint: 'problems_slug_uq' }),
    );
    await expect(
      new KyselyProblemsRepository(dup.db).insert({ ...p, examples: [] }),
    ).rejects.toBeInstanceOf(SlugTakenError);
    const other = createFakeDb(() => new Error('otra cosa'));
    await expect(
      new KyselyProblemsRepository(other.db).insert({ ...p, examples: [] }),
    ).rejects.toThrow('otra cosa');
  });

  it('update solo toca los campos del patch y actualiza updated_at', async () => {
    const { db, queries } = createFakeDb(() => [row]);
    await new KyselyProblemsRepository(db).update(ID, { title: 'X', published: false });
    expect(queries[0]!.sql).toBe(
      'update "problems" set "title" = $1, "published" = $2, "updated_at" = now() where "id" = $3 returning *',
    );
  });

  it('testcases: listar, upsert y marcar subidos', async () => {
    const tc = {
      id: 't1',
      problem_id: ID,
      ordinal: 1,
      uploaded_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const { db, queries } = createFakeDb(() => [tc]);
    const repo = new KyselyProblemsRepository(db);
    expect(await repo.listTestcases(ID)).toEqual([
      { id: 't1', problemId: ID, ordinal: 1, uploadedAt: null },
    ]);
    expect(queries[0]!.sql).toContain('order by "ordinal" asc');
    await repo.upsertTestcase({ id: 't1', problemId: ID, ordinal: 1 });
    expect(queries[1]!.sql).toContain(
      'on conflict ("problem_id", "ordinal") do update set "updated_at" = now()',
    );
    await repo.markTestcasesUploaded([], new Date());
    expect(queries).toHaveLength(2);
    await repo.markTestcasesUploaded(['t1', 't2'], new Date());
    expect(queries[2]!.sql).toContain('where "id" in ($2, $3) and "uploaded_at" is null');
  });
});

describe('helpers del repositorio', () => {
  it('isSlugUniqueViolation', () => {
    expect(isSlugUniqueViolation({ code: '23505', constraint: 'problems_slug_uq' })).toBe(true);
    expect(isSlugUniqueViolation({ code: '23505', constraint: 'otro' })).toBe(false);
    expect(isSlugUniqueViolation(null)).toBe(false);
    expect(isSlugUniqueViolation('x')).toBe(false);
  });

  it('toProblemRowUpdate mapea todos los campos', () => {
    expect(
      toProblemRowUpdate({
        title: 't',
        statement: 's',
        difficulty: 'HARD',
        tags: ['a'],
        timeLimitMs: 1,
        memoryLimitMb: 2,
        examples: [],
        published: true,
      }),
    ).toEqual({
      title: 't',
      statement: 's',
      difficulty: 'HARD',
      tags: ['a'],
      time_limit_ms: 1,
      memory_limit_mb: 2,
      examples: '[]',
      published: true,
    });
  });
});

describe('migraciones', () => {
  it('crea las tablas, restricciones e índices', async () => {
    const { db, queries } = createFakeDb(() => []);
    const { error, results } = await migrateToLatest(db);
    expect(error).toBeUndefined();
    expect(results?.map((r) => [r.migrationName, r.status])).toEqual([['0001_init', 'Success']]);
    const ddl = queries.map((q) => q.sql).join('\n');
    expect(ddl).toContain('create table "problems"');
    expect(ddl).toContain('"seq" bigint generated always as identity not null');
    expect(ddl).toContain('constraint "problems_slug_uq" unique ("slug")');
    expect(ddl).toContain('create index "problems_tags_gin" on "problems" using gin ("tags")');
    expect(ddl).toContain('create table "testcases"');
    expect(ddl).toContain('references "problems" ("id") on delete cascade');
  });

  it('down elimina las tablas', async () => {
    const { m0001Init } = await import('./migrations/0001_init.js');
    const { db, queries } = createFakeDb(() => []);
    await m0001Init.down?.(db);
    expect(queries.map((q) => q.sql)).toEqual(['drop table "testcases"', 'drop table "problems"']);
  });

  it('pingDb ejecuta select 1', async () => {
    const { db, queries } = createFakeDb(() => [{ '?column?': 1 }]);
    await pingDb(db);
    expect(queries[0]!.sql).toBe('select 1');
  });
});
