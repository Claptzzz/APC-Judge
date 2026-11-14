import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

export const DIFFICULTIES = ['EASY', 'MEDIUM', 'HARD'] as const;
export type DifficultyDb = (typeof DIFFICULTIES)[number];

export interface ExampleRow {
  input: string;
  output: string;
  explanation: string;
}

export interface ProblemsTable {
  id: string;
  /** Orden de creación; base del cursor de paginación. `bigint` llega como string desde pg. */
  seq: ColumnType<string, never, never>;
  slug: string;
  title: string;
  statement: string;
  difficulty: DifficultyDb;
  tags: string[];
  time_limit_ms: number;
  memory_limit_mb: number;
  /** jsonb: pg lo devuelve parseado; al escribir se manda JSON serializado. */
  examples: ColumnType<ExampleRow[], string, string>;
  published: Generated<boolean>;
  author_id: string;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, Date>;
}

export interface TestcasesTable {
  id: string;
  problem_id: string;
  ordinal: number;
  /** Momento en que se confirmó que input y output existen en S3; null = pendiente. */
  uploaded_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, Date>;
}

export interface Database {
  problems: ProblemsTable;
  testcases: TestcasesTable;
}

export type ProblemRow = Selectable<ProblemsTable>;
export type NewProblemRow = Insertable<ProblemsTable>;
export type ProblemRowUpdate = Updateable<ProblemsTable>;
export type TestcaseRow = Selectable<TestcasesTable>;
