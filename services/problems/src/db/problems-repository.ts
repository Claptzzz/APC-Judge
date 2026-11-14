import { sql } from 'kysely';
import type { Db } from './database.js';
import type {
  DifficultyDb,
  ExampleRow,
  ProblemRow,
  ProblemRowUpdate,
  TestcaseRow,
} from './schema.js';

export interface ProblemRecord {
  id: string;
  seq: string;
  slug: string;
  title: string;
  statement: string;
  difficulty: DifficultyDb;
  tags: string[];
  timeLimitMs: number;
  memoryLimitMb: number;
  examples: ExampleRow[];
  published: boolean;
  authorId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface TestcaseRecord {
  id: string;
  problemId: string;
  ordinal: number;
  uploadedAt: Date | null;
}

export interface NewProblem {
  id: string;
  slug: string;
  title: string;
  statement: string;
  difficulty: DifficultyDb;
  tags: string[];
  timeLimitMs: number;
  memoryLimitMb: number;
  examples: ExampleRow[];
  authorId: string;
}

export interface ProblemPatch {
  title?: string;
  statement?: string;
  difficulty?: DifficultyDb;
  tags?: string[];
  timeLimitMs?: number;
  memoryLimitMb?: number;
  examples?: ExampleRow[];
  published?: boolean;
}

export interface ListProblemsFilter {
  /** El problema debe tener todos estos tags. */
  tags: string[];
  difficulty?: DifficultyDb;
  publishedOnly: boolean;
  /** Cursor: devuelve problemas con `seq` mayor que este. */
  afterSeq?: string;
  limit: number;
}

export interface ProblemsRepository {
  list(filter: ListProblemsFilter): Promise<ProblemRecord[]>;
  findById(id: string): Promise<ProblemRecord | undefined>;
  findBySlug(slug: string): Promise<ProblemRecord | undefined>;
  /** Lanza SlugTakenError si el slug ya existe. */
  insert(problem: NewProblem): Promise<ProblemRecord>;
  update(id: string, patch: ProblemPatch): Promise<ProblemRecord | undefined>;
  /** Casos de prueba del problema ordenados por ordinal. */
  listTestcases(problemId: string): Promise<TestcaseRecord[]>;
  /** Crea el caso `ordinal` o devuelve el existente (sus archivos se reemplazan en S3). */
  upsertTestcase(testcase: {
    id: string;
    problemId: string;
    ordinal: number;
  }): Promise<TestcaseRecord>;
  markTestcasesUploaded(ids: string[], at: Date): Promise<void>;
}

export class SlugTakenError extends Error {
  override readonly name = 'SlugTakenError';
  constructor(readonly slug: string) {
    super(`el slug "${slug}" ya existe`);
  }
}

const UNIQUE_VIOLATION = '23505';
const SLUG_CONSTRAINT = 'problems_slug_uq';

export function isSlugUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { code, constraint } = err as { code?: unknown; constraint?: unknown };
  return code === UNIQUE_VIOLATION && constraint === SLUG_CONSTRAINT;
}

export function toProblemRecord(row: ProblemRow): ProblemRecord {
  return {
    id: row.id,
    seq: String(row.seq),
    slug: row.slug,
    title: row.title,
    statement: row.statement,
    difficulty: row.difficulty,
    tags: row.tags,
    timeLimitMs: row.time_limit_ms,
    memoryLimitMb: row.memory_limit_mb,
    examples: row.examples,
    published: row.published,
    authorId: row.author_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toTestcaseRecord(row: TestcaseRow): TestcaseRecord {
  return {
    id: row.id,
    problemId: row.problem_id,
    ordinal: row.ordinal,
    uploadedAt: row.uploaded_at,
  };
}

export function toProblemRowUpdate(patch: ProblemPatch): ProblemRowUpdate {
  const update: ProblemRowUpdate = {};
  if (patch.title !== undefined) update.title = patch.title;
  if (patch.statement !== undefined) update.statement = patch.statement;
  if (patch.difficulty !== undefined) update.difficulty = patch.difficulty;
  if (patch.tags !== undefined) update.tags = patch.tags;
  if (patch.timeLimitMs !== undefined) update.time_limit_ms = patch.timeLimitMs;
  if (patch.memoryLimitMb !== undefined) update.memory_limit_mb = patch.memoryLimitMb;
  if (patch.examples !== undefined) update.examples = JSON.stringify(patch.examples);
  if (patch.published !== undefined) update.published = patch.published;
  return update;
}

export class KyselyProblemsRepository implements ProblemsRepository {
  constructor(private readonly db: Db) {}

  async list(filter: ListProblemsFilter): Promise<ProblemRecord[]> {
    let query = this.db.selectFrom('problems').selectAll();
    if (filter.publishedOnly) query = query.where('published', '=', true);
    if (filter.difficulty) query = query.where('difficulty', '=', filter.difficulty);
    if (filter.tags.length > 0) query = query.where(sql<boolean>`tags @> ${filter.tags}::text[]`);
    if (filter.afterSeq !== undefined) query = query.where('seq', '>', filter.afterSeq);
    const rows = await query.orderBy('seq', 'asc').limit(filter.limit).execute();
    return rows.map(toProblemRecord);
  }

  async findById(id: string): Promise<ProblemRecord | undefined> {
    const row = await this.db
      .selectFrom('problems')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row && toProblemRecord(row);
  }

  async findBySlug(slug: string): Promise<ProblemRecord | undefined> {
    const row = await this.db
      .selectFrom('problems')
      .selectAll()
      .where('slug', '=', slug)
      .executeTakeFirst();
    return row && toProblemRecord(row);
  }

  async insert(p: NewProblem): Promise<ProblemRecord> {
    try {
      const row = await this.db
        .insertInto('problems')
        .values({
          id: p.id,
          slug: p.slug,
          title: p.title,
          statement: p.statement,
          difficulty: p.difficulty,
          tags: p.tags,
          time_limit_ms: p.timeLimitMs,
          memory_limit_mb: p.memoryLimitMb,
          examples: JSON.stringify(p.examples),
          author_id: p.authorId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toProblemRecord(row);
    } catch (err) {
      if (isSlugUniqueViolation(err)) throw new SlugTakenError(p.slug);
      throw err;
    }
  }

  async update(id: string, patch: ProblemPatch): Promise<ProblemRecord | undefined> {
    const row = await this.db
      .updateTable('problems')
      .set({ ...toProblemRowUpdate(patch), updated_at: sql<Date>`now()` })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    return row && toProblemRecord(row);
  }

  async listTestcases(problemId: string): Promise<TestcaseRecord[]> {
    const rows = await this.db
      .selectFrom('testcases')
      .selectAll()
      .where('problem_id', '=', problemId)
      .orderBy('ordinal', 'asc')
      .execute();
    return rows.map(toTestcaseRecord);
  }

  async upsertTestcase(tc: {
    id: string;
    problemId: string;
    ordinal: number;
  }): Promise<TestcaseRecord> {
    const row = await this.db
      .insertInto('testcases')
      .values({ id: tc.id, problem_id: tc.problemId, ordinal: tc.ordinal })
      .onConflict((oc) =>
        oc.columns(['problem_id', 'ordinal']).doUpdateSet({ updated_at: sql<Date>`now()` }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return toTestcaseRecord(row);
  }

  async markTestcasesUploaded(ids: string[], at: Date): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .updateTable('testcases')
      .set({ uploaded_at: at, updated_at: sql<Date>`now()` })
      .where('id', 'in', ids)
      .where('uploaded_at', 'is', null)
      .execute();
  }
}
