import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// Mantener sincronizado con migrations/*.sql (las migraciones se escriben a mano;
// drizzle-kit no se usa porque depende de esbuild, que requiere postinstall).

// Precisión de milisegundos: JS no tiene más y los cursores de paginación usan Date.
const ts = (name: string) => timestamp(name, { withTimezone: true, precision: 3 });

export const contests = pgTable(
  'contests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    startTime: ts('start_time').notNull(),
    endTime: ts('end_time').notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('contests_start_time_id_idx').on(t.startTime.desc(), t.id.desc()),
    check('contests_window_check', sql`${t.startTime} < ${t.endTime}`),
  ],
);

export const contestProblems = pgTable(
  'contest_problems',
  {
    contestId: uuid('contest_id')
      .notNull()
      .references(() => contests.id, { onDelete: 'cascade' }),
    problemId: uuid('problem_id').notNull(),
    position: integer('position').notNull(),
    letter: text('letter').notNull(),
  },
  (t) => [
    primaryKey({ name: 'contest_problems_pkey', columns: [t.contestId, t.position] }),
    uniqueIndex('contest_problems_contest_problem_key').on(t.contestId, t.problemId),
    uniqueIndex('contest_problems_contest_letter_key').on(t.contestId, t.letter),
  ],
);

export const usernames = pgTable('usernames', {
  userId: uuid('user_id').primaryKey(),
  username: text('username').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const judgedSubmissions = pgTable(
  'judged_submissions',
  {
    submissionId: uuid('submission_id').primaryKey(),
    userId: uuid('user_id').notNull(),
    problemId: uuid('problem_id').notNull(),
    contestId: uuid('contest_id'),
    verdict: text('verdict').notNull(),
    submittedAt: ts('submitted_at').notNull(),
    judgedAt: ts('judged_at').notNull(),
    eventId: text('event_id').notNull(),
  },
  (t) => [
    index('judged_submissions_contest_user_idx').on(t.contestId, t.userId),
    index('judged_submissions_user_idx').on(t.userId),
  ],
);

export const processedEvents = pgTable('processed_events', {
  eventId: text('event_id').primaryKey(),
  topic: text('topic').notNull(),
  processedAt: ts('processed_at').notNull().defaultNow(),
});
