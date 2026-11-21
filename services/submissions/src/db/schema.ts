import { sql } from 'drizzle-orm';
import {
  bigserial,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const languageValues = ['CPP17', 'PYTHON3'] as const;
export type LanguageName = (typeof languageValues)[number];
export const submissionLanguage = pgEnum('submission_language', languageValues);

export const verdictValues = [
  'PENDING',
  'JUDGING',
  'ACCEPTED',
  'WRONG_ANSWER',
  'TIME_LIMIT_EXCEEDED',
  'MEMORY_LIMIT_EXCEEDED',
  'RUNTIME_ERROR',
  'COMPILATION_ERROR',
  'INTERNAL_ERROR',
] as const;
export type VerdictName = (typeof verdictValues)[number];
export const submissionVerdict = pgEnum('submission_verdict', verdictValues);

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

export const submissions = pgTable(
  'submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    problemId: uuid('problem_id').notNull(),
    contestId: uuid('contest_id'),
    language: submissionLanguage('language').notNull(),
    sourceCode: text('source_code').notNull(),
    verdict: submissionVerdict('verdict').notNull().default('PENDING'),
    timeMs: integer('time_ms').notNull().default(0),
    memoryKb: integer('memory_kb').notNull().default(0),
    passedCases: integer('passed_cases').notNull().default(0),
    totalCases: integer('total_cases').notNull().default(0),
    submittedAt: timestamp('submitted_at', { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    judgedAt: timestamp('judged_at', { withTimezone: true }),
  },
  (t) => [
    index('submissions_user_id_idx').on(t.userId),
    index('submissions_problem_id_idx').on(t.problemId),
    index('submissions_contest_id_idx')
      .on(t.contestId)
      .where(sql`${t.contestId} is not null`),
    index('submissions_submitted_at_idx').on(t.submittedAt.desc(), t.id.desc()),
  ],
);

export const outbox = pgTable(
  'outbox',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    eventId: uuid('event_id').notNull(),
    topic: text('topic').notNull(),
    messageKey: text('message_key').notNull(),
    payload: bytea('payload').notNull(),
    headers: jsonb('headers').$type<Record<string, string>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('outbox_event_id_key').on(t.eventId),
    index('outbox_unpublished_idx')
      .on(t.id)
      .where(sql`${t.publishedAt} is null`),
  ],
);

export const processedEvents = pgTable('processed_events', {
  eventId: uuid('event_id').primaryKey(),
  topic: text('topic').notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
});

export type SubmissionRow = typeof submissions.$inferSelect;
export type OutboxRow = typeof outbox.$inferSelect;
export type ProcessedEventRow = typeof processedEvents.$inferSelect;
