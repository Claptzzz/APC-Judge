import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

export const m0001Init: Migration = {
  async up(db: Kysely<never>): Promise<void> {
    await db.schema
      .createTable('problems')
      .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('seq', 'bigint', (c) => c.notNull().generatedAlwaysAsIdentity())
      .addColumn('slug', 'text', (c) => c.notNull())
      .addColumn('title', 'text', (c) => c.notNull())
      .addColumn('statement', 'text', (c) => c.notNull().defaultTo(''))
      .addColumn('difficulty', 'text', (c) => c.notNull())
      .addColumn('tags', sql`text[]`, (c) => c.notNull().defaultTo(sql`'{}'::text[]`))
      .addColumn('time_limit_ms', 'integer', (c) => c.notNull())
      .addColumn('memory_limit_mb', 'integer', (c) => c.notNull())
      .addColumn('examples', 'jsonb', (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
      .addColumn('published', 'boolean', (c) => c.notNull().defaultTo(false))
      .addColumn('author_id', 'uuid', (c) => c.notNull())
      .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
      .addUniqueConstraint('problems_slug_uq', ['slug'])
      .addUniqueConstraint('problems_seq_uq', ['seq'])
      .addCheckConstraint('problems_difficulty_ck', sql`difficulty in ('EASY', 'MEDIUM', 'HARD')`)
      .addCheckConstraint('problems_time_limit_ck', sql`time_limit_ms > 0`)
      .addCheckConstraint('problems_memory_limit_ck', sql`memory_limit_mb > 0`)
      .execute();

    // Filtro "tiene todos estos tags": tags @> $1 usa el índice GIN.
    await db.schema
      .createIndex('problems_tags_gin')
      .on('problems')
      .using('gin')
      .column('tags')
      .execute();
    await db.schema
      .createIndex('problems_published_seq_idx')
      .on('problems')
      .columns(['published', 'seq'])
      .execute();

    await db.schema
      .createTable('testcases')
      .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('problem_id', 'uuid', (c) =>
        c.notNull().references('problems.id').onDelete('cascade'),
      )
      .addColumn('ordinal', 'integer', (c) => c.notNull())
      .addColumn('uploaded_at', 'timestamptz')
      .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
      .addUniqueConstraint('testcases_problem_ordinal_uq', ['problem_id', 'ordinal'])
      .addCheckConstraint('testcases_ordinal_ck', sql`ordinal >= 1`)
      .execute();
  },

  async down(db: Kysely<never>): Promise<void> {
    await db.schema.dropTable('testcases').execute();
    await db.schema.dropTable('problems').execute();
  },
};
