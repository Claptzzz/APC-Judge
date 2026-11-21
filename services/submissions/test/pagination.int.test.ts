// Integración contra Postgres local: `pnpm infra:up` y luego
//   pnpm --filter @juez/submissions test:int
// Aplica las migraciones sobre SUBMISSIONS_DATABASE_URL y pagina ListSubmissions con datos reales.
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/db/client.js';
import type { Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { submissions } from '../src/db/schema.js';
import { DrizzleSubmissionsRepository } from '../src/repository.js';

const databaseUrl = process.env.SUBMISSIONS_DATABASE_URL;
if (!databaseUrl) throw new Error('SUBMISSIONS_DATABASE_URL no definida');

// problem_id propio de esta corrida para aislar los datos (filtro de ListSubmissions).
const problemId = randomUUID();
const userId = randomUUID();

let database: Database;
let repo: DrizzleSubmissionsRepository;

async function insertAt(submittedAt: string): Promise<string> {
  const id = randomUUID();
  // Literal con microsegundos, como los que produce now(): simula dos envíos dentro del mismo
  // milisegundo. Con timestamp(3) Postgres los guarda redondeados al milisegundo.
  await database.db.execute(sql`
    insert into submissions (id, user_id, problem_id, language, source_code, submitted_at)
    values (${id}, ${userId}, ${problemId}, 'CPP17', 'int main() {}', ${submittedAt}::timestamptz)
  `);
  return id;
}

async function listAll(pageSize: number): Promise<string[][]> {
  const pages: string[][] = [];
  let pageToken: string | undefined;
  do {
    const res = await repo.list({ pageSize, pageToken, problemId });
    pages.push(res.submissions.map((s) => s.id));
    pageToken = res.nextPageToken;
  } while (pageToken && pages.length < 20);
  return pages;
}

beforeAll(async () => {
  database = createDatabase(databaseUrl, { max: 2 });
  await runMigrations(database.db);
  repo = new DrizzleSubmissionsRepository(database.db);
});

afterAll(async () => {
  await database?.db.delete(submissions).where(eq(submissions.problemId, problemId));
  await database?.close();
});

describe('ListSubmissions — paginación por cursor (integración)', () => {
  it('submitted_at es timestamp(3) with time zone', async () => {
    const rows = await database.db.execute<{ data_type: string; datetime_precision: number }>(sql`
      select data_type, datetime_precision
      from information_schema.columns
      where table_name = 'submissions' and column_name = 'submitted_at'
    `);
    expect(rows[0]).toEqual({ data_type: 'timestamp with time zone', datetime_precision: 3 });
  });

  it('dos submissions en el mismo milisegundo no se pierden entre páginas', async () => {
    const a = await insertAt('2026-11-20T12:00:00.123100Z');
    const b = await insertAt('2026-11-20T12:00:00.123400Z');

    // pageSize 1: el cursor de la 1ª página cae justo en ese milisegundo.
    const pages = await listAll(1);
    const ids = pages.flat();

    expect(pages).toHaveLength(2);
    expect(ids).toHaveLength(2);
    expect(new Set(ids)).toEqual(new Set([a, b]));
  });

  it('pagina sin perder ni repetir filas con varios empates de milisegundo', async () => {
    const extra = [
      await insertAt('2026-11-20T12:00:01.500001Z'),
      await insertAt('2026-11-20T12:00:01.500200Z'),
      await insertAt('2026-11-20T12:00:01.500499Z'),
      await insertAt('2026-11-20T12:00:02.000000Z'),
    ];
    const all = await database.db
      .select({ id: submissions.id })
      .from(submissions)
      .where(eq(submissions.problemId, problemId));

    for (const pageSize of [1, 2, 3]) {
      const ids = (await listAll(pageSize)).flat();
      expect(ids).toHaveLength(all.length);
      expect(new Set(ids).size).toBe(all.length);
      for (const id of extra) expect(ids).toContain(id);
    }
  });
});
