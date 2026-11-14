import { sql } from 'drizzle-orm';
import {
  bigserial,
  customType,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// Mantener sincronizado con migrations/*.sql (las migraciones se escriben a mano;
// drizzle-kit no se usa porque depende de esbuild, que requiere postinstall).

export const roleValues = ['CONTESTANT', 'SETTER', 'ADMIN'] as const;
export type RoleName = (typeof roleValues)[number];

export const userRole = pgEnum('user_role', roleValues);

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    username: text('username').notNull(),
    // Siempre en minúsculas (CHECK en la migración).
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: userRole('role').notNull().default('CONTESTANT'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_username_lower_key').on(sql`lower(${t.username})`),
    uniqueIndex('users_email_key').on(t.email),
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

export type UserRow = typeof users.$inferSelect;
export type OutboxRow = typeof outbox.$inferSelect;

/** Nombres de las restricciones únicas, para traducir violaciones a errores de dominio. */
export const UNIQUE_CONSTRAINTS = {
  username: 'users_username_lower_key',
  email: 'users_email_key',
} as const;
