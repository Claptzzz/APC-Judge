import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from './migrate.js';
import { submissions } from './schema.js';
import { decodeCursor, encodeCursor } from '../repository.js';

describe('submitted_at con precisión de milisegundos', () => {
  it('el schema declara timestamp(3) with time zone (misma precisión que el cursor)', () => {
    const column = getTableConfig(submissions).columns.find((c) => c.name === 'submitted_at');
    expect(column?.getSQLType()).toBe('timestamp (3) with time zone');
  });

  it('la migración 0001 está registrada en el journal y cambia la columna', () => {
    const journal = JSON.parse(
      readFileSync(join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'),
    ) as {
      entries: { idx: number; tag: string; when: number }[];
    };
    const [init, ms] = journal.entries;
    expect(ms?.tag).toBe('0001_submitted_at_ms_precision');
    expect(ms!.when).toBeGreaterThan(init!.when);

    const file = join(MIGRATIONS_DIR, `${ms!.tag}.sql`);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toMatch(
      /ALTER COLUMN "submitted_at" SET DATA TYPE timestamp\(3\) with time zone/,
    );
  });

  it('un valor con precisión de milisegundos sobrevive intacto al cursor', () => {
    const d = new Date('2026-11-20T12:00:00.123Z');
    const cursor = decodeCursor(encodeCursor(d, 'id'));
    expect(new Date(cursor!.s).getTime()).toBe(d.getTime());
  });
});
