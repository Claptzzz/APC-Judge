import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { Db } from './client.js';

/** Carpeta services/submissions/migrations (misma ruta relativa desde src/ y desde dist/). */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

export async function runMigrations(db: Db, migrationsFolder: string = MIGRATIONS_DIR) {
  await migrate(db, { migrationsFolder });
}
