// Dobles de prueba compartidos por los tests (excluidos del build y de la cobertura).
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Driver,
} from 'kysely';
import { pino } from 'pino';
import type {
  ListProblemsFilter,
  NewProblem,
  ProblemPatch,
  ProblemRecord,
  ProblemsRepository,
  TestcaseRecord,
} from '../db/problems-repository.js';
import { SlugTakenError } from '../db/problems-repository.js';
import type { Database } from '../db/schema.js';
import {
  testcaseKeys,
  type PresignedPair,
  type TestcaseStorage,
} from '../storage/testcase-storage.js';

export const silentLogger = pino({ level: 'silent' });

export interface RecordedQuery {
  sql: string;
  parameters: readonly unknown[];
}

/** Kysely sobre un driver falso: registra el SQL compilado y responde con filas fijas. */
export function createFakeDb(responder: (q: RecordedQuery) => unknown[] | Error = () => []) {
  const queries: RecordedQuery[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: { sql: string; parameters: readonly unknown[] }) {
      const q = { sql: compiled.sql, parameters: compiled.parameters };
      queries.push(q);
      const rows = responder(q);
      return rows instanceof Error ? Promise.reject(rows) : Promise.resolve({ rows: rows as R[] });
    },
    streamQuery() {
      throw new Error('streamQuery no soportado en el fake');
    },
  };
  const noop = () => Promise.resolve();
  const driver: Driver = {
    init: noop,
    acquireConnection: () => Promise.resolve(connection),
    beginTransaction: noop,
    commitTransaction: noop,
    rollbackTransaction: noop,
    releaseConnection: noop,
    destroy: noop,
  };
  const db = new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, queries };
}

export function problemRecord(overrides: Partial<ProblemRecord> = {}): ProblemRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    seq: '1',
    slug: 'a-mas-b',
    title: 'A + B',
    statement: 'Suma',
    difficulty: 'EASY',
    tags: ['math'],
    timeLimitMs: 1000,
    memoryLimitMb: 256,
    examples: [],
    published: true,
    authorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    createdAt: new Date('2026-11-10T00:00:00Z'),
    updatedAt: new Date('2026-11-10T00:00:00Z'),
    ...overrides,
  };
}

/** Repositorio en memoria con la misma semántica que el de Kysely. */
export class InMemoryProblemsRepository implements ProblemsRepository {
  problems: ProblemRecord[] = [];
  testcases: TestcaseRecord[] = [];
  private seq = 0;

  add(overrides: Partial<ProblemRecord> = {}): ProblemRecord {
    const p = problemRecord({ seq: String(++this.seq), ...overrides });
    this.problems.push(p);
    return p;
  }

  list(f: ListProblemsFilter): Promise<ProblemRecord[]> {
    const rows = this.problems
      .filter((p) => !f.publishedOnly || p.published)
      .filter((p) => !f.difficulty || p.difficulty === f.difficulty)
      .filter((p) => f.tags.every((t) => p.tags.includes(t)))
      .filter((p) => f.afterSeq === undefined || BigInt(p.seq) > BigInt(f.afterSeq))
      .sort((a, b) => Number(BigInt(a.seq) - BigInt(b.seq)))
      .slice(0, f.limit);
    return Promise.resolve(rows);
  }

  findById(id: string) {
    return Promise.resolve(this.problems.find((p) => p.id === id));
  }

  findBySlug(slug: string) {
    return Promise.resolve(this.problems.find((p) => p.slug === slug));
  }

  insert(p: NewProblem): Promise<ProblemRecord> {
    if (this.problems.some((x) => x.slug === p.slug))
      return Promise.reject(new SlugTakenError(p.slug));
    const now = new Date('2026-11-11T00:00:00Z');
    const { authorId, ...rest } = p;
    return Promise.resolve(
      this.add({ ...rest, authorId, published: false, createdAt: now, updatedAt: now }),
    );
  }

  update(id: string, patch: ProblemPatch): Promise<ProblemRecord | undefined> {
    const i = this.problems.findIndex((p) => p.id === id);
    if (i < 0) return Promise.resolve(undefined);
    const updated = { ...this.problems[i]!, ...patch, updatedAt: new Date('2026-11-12T00:00:00Z') };
    this.problems[i] = updated;
    return Promise.resolve(updated);
  }

  listTestcases(problemId: string) {
    return Promise.resolve(
      this.testcases.filter((t) => t.problemId === problemId).sort((a, b) => a.ordinal - b.ordinal),
    );
  }

  upsertTestcase(tc: { id: string; problemId: string; ordinal: number }): Promise<TestcaseRecord> {
    const existing = this.testcases.find(
      (t) => t.problemId === tc.problemId && t.ordinal === tc.ordinal,
    );
    if (existing) return Promise.resolve(existing);
    const created = { ...tc, uploadedAt: null };
    this.testcases.push(created);
    return Promise.resolve(created);
  }

  markTestcasesUploaded(ids: string[], at: Date): Promise<void> {
    this.testcases = this.testcases.map((t) =>
      ids.includes(t.id) && !t.uploadedAt ? { ...t, uploadedAt: at } : t,
    );
    return Promise.resolve();
  }
}

/** Almacenamiento en memoria: las "URLs" codifican operación, endpoint y clave. */
export class FakeTestcaseStorage implements TestcaseStorage {
  objects = new Map<string, string | Uint8Array>();
  failExists = false;
  bucketCreated = false;
  pingError: Error | undefined;

  private pair(kind: string, problemId: string, ordinal: number, ttl: number): PresignedPair {
    const keys = testcaseKeys(problemId, ordinal);
    return {
      inputUrl: `${kind}/${keys.input}`,
      outputUrl: `${kind}/${keys.output}`,
      expiresAt: new Date(Date.parse('2026-11-11T00:00:00Z') + ttl * 1000),
    };
  }

  presignUpload(problemId: string, ordinal: number) {
    return Promise.resolve(this.pair('http://public:9000/PUT', problemId, ordinal, 900));
  }

  presignDownload(problemId: string, ordinal: number) {
    return Promise.resolve(this.pair('http://minio:9000/GET', problemId, ordinal, 600));
  }

  testcaseExists(problemId: string, ordinal: number) {
    if (this.failExists) return Promise.reject(new Error('s3 caído'));
    const keys = testcaseKeys(problemId, ordinal);
    return Promise.resolve(this.objects.has(keys.input) && this.objects.has(keys.output));
  }

  putObject(key: string, body: string | Uint8Array) {
    this.objects.set(key, body);
    return Promise.resolve();
  }

  ensureBucket() {
    this.bucketCreated = true;
    return Promise.resolve();
  }

  ping() {
    return this.pingError ? Promise.reject(this.pingError) : Promise.resolve();
  }

  destroy() {}
}
