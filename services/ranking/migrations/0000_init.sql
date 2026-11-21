CREATE TABLE "contests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "title" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "start_time" timestamp(3) with time zone NOT NULL,
  "end_time" timestamp(3) with time zone NOT NULL,
  "created_by" uuid NOT NULL,
  "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "contests_window_check" CHECK ("start_time" < "end_time")
);
--> statement-breakpoint
CREATE INDEX "contests_start_time_id_idx" ON "contests" ("start_time" DESC, "id" DESC);
--> statement-breakpoint
CREATE TABLE "contest_problems" (
  "contest_id" uuid NOT NULL REFERENCES "contests" ("id") ON DELETE CASCADE,
  "problem_id" uuid NOT NULL,
  "position" integer NOT NULL,
  "letter" text NOT NULL,
  CONSTRAINT "contest_problems_pkey" PRIMARY KEY ("contest_id", "position"),
  CONSTRAINT "contest_problems_position_check" CHECK ("position" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "contest_problems_contest_problem_key" ON "contest_problems" ("contest_id", "problem_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "contest_problems_contest_letter_key" ON "contest_problems" ("contest_id", "letter");
--> statement-breakpoint
CREATE TABLE "usernames" (
  "user_id" uuid PRIMARY KEY NOT NULL,
  "username" text NOT NULL,
  "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "judged_submissions" (
  "submission_id" uuid PRIMARY KEY NOT NULL,
  "user_id" uuid NOT NULL,
  "problem_id" uuid NOT NULL,
  -- Sin FK a contests: si el evento trae un contest que no existe la submission se guarda
  -- igual (sirve para las estadísticas) y no afecta ningún scoreboard.
  "contest_id" uuid,
  "verdict" text NOT NULL,
  "submitted_at" timestamp(3) with time zone NOT NULL,
  "judged_at" timestamp(3) with time zone NOT NULL,
  "event_id" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "judged_submissions_contest_user_idx" ON "judged_submissions" ("contest_id", "user_id");
--> statement-breakpoint
CREATE INDEX "judged_submissions_user_idx" ON "judged_submissions" ("user_id");
--> statement-breakpoint
CREATE TABLE "processed_events" (
  "event_id" text PRIMARY KEY NOT NULL,
  "topic" text NOT NULL,
  "processed_at" timestamp(3) with time zone DEFAULT now() NOT NULL
);
