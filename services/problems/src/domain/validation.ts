import { Code, ConnectError } from '@connectrpc/connect';
import {
  Difficulty,
  type CreateProblemRequest,
  type Example,
  type UpdateProblemRequest,
} from '@juez/contracts/es';
import type { NewProblem, ProblemPatch } from '../db/problems-repository.js';
import type { DifficultyDb, ExampleRow } from '../db/schema.js';
import { isValidSlug, SLUG_MAX_LENGTH } from './slug.js';

export const LIMITS = {
  titleMax: 200,
  statementMax: 100_000,
  tagsMax: 20,
  tagMax: 40,
  examplesMax: 20,
  exampleFieldMax: 10_000,
  timeLimitMs: { min: 100, max: 20_000, default: 1_000 },
  memoryLimitMb: { min: 16, max: 2_048, default: 256 },
  ordinalMax: 1_000,
  pageSize: { default: 20, max: 100 },
} as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const invalid = (message: string): ConnectError =>
  new ConnectError(message, Code.InvalidArgument);

export function requireUuid(value: string, field: string): string {
  if (!UUID_PATTERN.test(value)) throw invalid(`${field} debe ser un UUID`);
  return value.toLowerCase();
}

const DIFFICULTY_TO_DB: Partial<Record<Difficulty, DifficultyDb>> = {
  [Difficulty.EASY]: 'EASY',
  [Difficulty.MEDIUM]: 'MEDIUM',
  [Difficulty.HARD]: 'HARD',
};

const DIFFICULTY_FROM_DB: Record<DifficultyDb, Difficulty> = {
  EASY: Difficulty.EASY,
  MEDIUM: Difficulty.MEDIUM,
  HARD: Difficulty.HARD,
};

/** undefined = UNSPECIFIED (sin filtro / no cambiar). Lanza si el valor no existe en el enum. */
export function difficultyToDb(value: Difficulty): DifficultyDb | undefined {
  if (value === Difficulty.UNSPECIFIED) return undefined;
  const db = DIFFICULTY_TO_DB[value];
  if (!db) throw invalid(`difficulty desconocida: ${value}`);
  return db;
}

export const difficultyFromDb = (value: DifficultyDb): Difficulty => DIFFICULTY_FROM_DB[value];

function title(value: string): string {
  const t = value.trim();
  if (t.length === 0) throw invalid('title es obligatorio');
  if (t.length > LIMITS.titleMax) throw invalid(`title admite hasta ${LIMITS.titleMax} caracteres`);
  return t;
}

function statement(value: string): string {
  if (value.length > LIMITS.statementMax)
    throw invalid(`statement admite hasta ${LIMITS.statementMax} caracteres`);
  return value;
}

/** Tags normalizados: sin espacios extremos, en minúsculas y sin duplicados. */
export function normalizeTags(values: readonly string[]): string[] {
  const tags = [...new Set(values.map((t) => t.trim().toLowerCase()))];
  if (tags.length > LIMITS.tagsMax) throw invalid(`se admiten hasta ${LIMITS.tagsMax} tags`);
  for (const tag of tags) {
    if (tag.length === 0) throw invalid('los tags no pueden estar vacíos');
    if (tag.length > LIMITS.tagMax)
      throw invalid(`cada tag admite hasta ${LIMITS.tagMax} caracteres`);
  }
  return tags;
}

function examples(values: readonly Example[]): ExampleRow[] {
  if (values.length > LIMITS.examplesMax)
    throw invalid(`se admiten hasta ${LIMITS.examplesMax} ejemplos`);
  return values.map((e, i) => {
    for (const field of ['input', 'output', 'explanation'] as const) {
      if (e[field].length > LIMITS.exampleFieldMax) {
        throw invalid(`examples[${i}].${field} admite hasta ${LIMITS.exampleFieldMax} caracteres`);
      }
    }
    return { input: e.input, output: e.output, explanation: e.explanation };
  });
}

function bounded(value: number, field: string, range: { min: number; max: number }): number {
  if (!Number.isInteger(value) || value < range.min || value > range.max) {
    throw invalid(`${field} debe estar entre ${range.min} y ${range.max}`);
  }
  return value;
}

export type ValidatedCreate = Omit<NewProblem, 'id' | 'slug' | 'authorId'> & {
  /** Slug pedido explícitamente; undefined = generarlo desde el título. */
  slug: string | undefined;
};

export function validateCreate(req: CreateProblemRequest): ValidatedCreate {
  const slug = req.slug.trim();
  if (slug !== '' && !isValidSlug(slug)) {
    throw invalid(
      `slug inválido: solo a-z, 0-9 y guiones simples, hasta ${SLUG_MAX_LENGTH} caracteres`,
    );
  }
  const difficulty = difficultyToDb(req.difficulty);
  if (!difficulty) throw invalid('difficulty es obligatoria');
  return {
    slug: slug === '' ? undefined : slug,
    title: title(req.title),
    statement: statement(req.statement),
    difficulty,
    tags: normalizeTags(req.tags),
    // int32 en proto3: 0 = no indicado → valor por defecto.
    timeLimitMs: bounded(
      req.timeLimitMs || LIMITS.timeLimitMs.default,
      'time_limit_ms',
      LIMITS.timeLimitMs,
    ),
    memoryLimitMb: bounded(
      req.memoryLimitMb || LIMITS.memoryLimitMb.default,
      'memory_limit_mb',
      LIMITS.memoryLimitMb,
    ),
    examples: examples(req.examples),
  };
}

export function validateUpdate(req: UpdateProblemRequest): ProblemPatch {
  const patch: ProblemPatch = {};
  if (req.title !== undefined) patch.title = title(req.title);
  if (req.statement !== undefined) patch.statement = statement(req.statement);
  const difficulty = difficultyToDb(req.difficulty);
  if (difficulty) patch.difficulty = difficulty;
  if (req.timeLimitMs !== undefined)
    patch.timeLimitMs = bounded(req.timeLimitMs, 'time_limit_ms', LIMITS.timeLimitMs);
  if (req.memoryLimitMb !== undefined) {
    patch.memoryLimitMb = bounded(req.memoryLimitMb, 'memory_limit_mb', LIMITS.memoryLimitMb);
  }
  if (req.tags) patch.tags = normalizeTags(req.tags.values);
  if (req.examples) patch.examples = examples(req.examples.values);
  if (req.published !== undefined) patch.published = req.published;
  return patch;
}

export function validateOrdinal(ordinal: number): number {
  return bounded(ordinal, 'ordinal', { min: 1, max: LIMITS.ordinalMax });
}

export function pageSize(requested: number): number {
  if (requested < 0) throw invalid('page_size no puede ser negativo');
  if (requested === 0) return LIMITS.pageSize.default;
  return Math.min(requested, LIMITS.pageSize.max);
}

/** Cursor opaco de paginación: base64url de `seq`. */
export function encodePageToken(seq: string): string {
  return Buffer.from(`s:${seq}`, 'utf8').toString('base64url');
}

export function decodePageToken(token: string): string | undefined {
  if (token === '') return undefined;
  const decoded = Buffer.from(token, 'base64url').toString('utf8');
  const match = /^s:(\d{1,19})$/.exec(decoded);
  if (!match?.[1]) throw invalid('page_token inválido');
  return match[1];
}
