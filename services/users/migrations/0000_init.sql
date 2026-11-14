CREATE TYPE "user_role" AS ENUM ('CONTESTANT', 'SETTER', 'ADMIN');
--> statement-breakpoint
CREATE TABLE "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "username" text NOT NULL,
  "email" text NOT NULL,
  "password_hash" text NOT NULL,
  "role" "user_role" DEFAULT 'CONTESTANT' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "users_email_lowercase_check" CHECK ("email" = lower("email"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_lower_key" ON "users" (lower("username"));
--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" ("email");
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
