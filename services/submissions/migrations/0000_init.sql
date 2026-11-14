CREATE TYPE "submission_language" AS ENUM ('CPP17', 'PYTHON3');
--> statement-breakpoint
CREATE TYPE "submission_verdict" AS ENUM ('PENDING', 'JUDGING', 'ACCEPTED', 'WRONG_ANSWER', 'TIME_LIMIT_EXCEEDED', 'MEMORY_LIMIT_EXCEEDED', 'RUNTIME_ERROR', 'COMPILATION_ERROR', 'INTERNAL_ERROR');
--> statement-breakpoint
CREATE TABLE "submissions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "problem_id" uuid NOT NULL,
  "contest_id" uuid,
  "language" "submission_language" NOT NULL,
  "source_code" text NOT NULL,
  "verdict" "submission_verdict" DEFAULT 'PENDING' NOT NULL,
  "time_ms" integer DEFAULT 0 NOT NULL,
  "memory_kb" integer DEFAULT 0 NOT NULL,
  "passed_cases" integer DEFAULT 0 NOT NULL,
  "total_cases" integer DEFAULT 0 NOT NULL,
  "submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "judged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "submissions_user_id_idx" ON "submissions" ("user_id");
--> statement-breakpoint
CREATE INDEX "submissions_problem_id_idx" ON "submissions" ("problem_id");
--> statement-breakpoint
CREATE INDEX "submissions_contest_id_idx" ON "submissions" ("contest_id") WHERE "contest_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "submissions_submitted_at_idx" ON "submissions" ("submitted_at" DESC, "id" DESC);
--> statement-breakpoint
CREATE TABLE "outbox" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "event_id" uuid NOT NULL,
  "topic" text NOT NULL,
  "message_key" text NOT NULL,
  "payload" bytea NOT NULL,
  "headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_event_id_key" ON "outbox" ("event_id");
--> statement-breakpoint
CREATE INDEX "outbox_unpublished_idx" ON "outbox" ("id") WHERE "published_at" IS NULL;
--> statement-breakpoint
CREATE TABLE "processed_events" (
  "event_id" uuid PRIMARY KEY NOT NULL,
  "topic" text NOT NULL,
  "processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
