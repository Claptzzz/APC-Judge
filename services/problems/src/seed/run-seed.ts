import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { Db } from '../db/database.js';
import type { Logger } from '../logger.js';
import { testcaseKeys, type TestcaseStorage } from '../storage/testcase-storage.js';
import { SEED_AUTHOR_ID, SEED_PROBLEMS, type SeedProblem } from './seed-data.js';

export interface SeedResult {
  slug: string;
  problemId: string;
  testcases: number;
}

export interface RunSeedOptions {
  db: Db;
  storage: TestcaseStorage;
  logger: Logger;
  problems?: SeedProblem[];
  newId?: () => string;
}

/**
 * Crea o actualiza los problemas de ejemplo y sube sus casos a S3. Idempotente: hace upsert por
 * slug (el id se conserva), sobrescribe los mismos objetos y borra casos sobrantes.
 */
export async function runSeed({
  db,
  storage,
  logger,
  problems = SEED_PROBLEMS,
  newId = randomUUID,
}: RunSeedOptions): Promise<SeedResult[]> {
  await storage.ensureBucket();
  const results: SeedResult[] = [];

  for (const p of problems) {
    const fields = {
      title: p.title,
      statement: p.statement,
      difficulty: p.difficulty,
      tags: p.tags,
      time_limit_ms: p.timeLimitMs,
      memory_limit_mb: p.memoryLimitMb,
      examples: JSON.stringify(p.examples),
      published: true,
    };
    const { id: problemId } = await db
      .insertInto('problems')
      .values({ id: newId(), slug: p.slug, author_id: SEED_AUTHOR_ID, ...fields })
      .onConflict((oc) =>
        oc.column('slug').doUpdateSet({ ...fields, updated_at: sql<Date>`now()` }),
      )
      .returning('id')
      .executeTakeFirstOrThrow();

    const testcases = p.testcases();
    for (const [i, tc] of testcases.entries()) {
      const ordinal = i + 1;
      const keys = testcaseKeys(problemId, ordinal);
      await storage.putObject(keys.input, tc.input);
      await storage.putObject(keys.output, tc.output);
      await db
        .insertInto('testcases')
        .values({ id: newId(), problem_id: problemId, ordinal, uploaded_at: new Date() })
        .onConflict((oc) =>
          oc
            .columns(['problem_id', 'ordinal'])
            .doUpdateSet({ uploaded_at: sql<Date>`now()`, updated_at: sql<Date>`now()` }),
        )
        .execute();
    }
    await db
      .deleteFrom('testcases')
      .where('problem_id', '=', problemId)
      .where('ordinal', '>', testcases.length)
      .execute();

    logger.info({ slug: p.slug, problemId, testcases: testcases.length }, 'problema sembrado');
    results.push({ slug: p.slug, problemId, testcases: testcases.length });
  }
  return results;
}
