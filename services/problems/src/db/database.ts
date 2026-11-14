import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator, type Migration, type MigrationResultSet } from 'kysely/migration';
import pg from 'pg';
import { m0001Init } from './migrations/0001_init.js';
import type { Database } from './schema.js';

export type Db = Kysely<Database>;

export function createDb(connectionString: string, maxConnections = 10): Db {
  const pool = new pg.Pool({ connectionString, max: maxConnections });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/** Migraciones versionadas del servicio (orden alfabético por nombre). */
export const migrations: Record<string, Migration> = {
  '0001_init': m0001Init,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- el Migrator opera sobre cualquier esquema
export function createMigrator(db: Kysely<any>): Migrator {
  return new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(migrations) },
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ídem
export async function migrateToLatest(db: Kysely<any>): Promise<MigrationResultSet> {
  return createMigrator(db).migrateToLatest();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ídem
export async function pingDb(db: Kysely<any>): Promise<void> {
  await sql`select 1`.execute(db);
}
