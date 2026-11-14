// db:migrate — aplica las migraciones pendientes (Kysely Migrator).
import { migrateConfigSchema, parseConfig } from '../config.js';
import { createDb, migrateToLatest } from '../db/database.js';
import { createLogger } from '../logger.js';

const config = parseConfig(migrateConfigSchema, process.env);
const logger = createLogger(config.LOG_LEVEL);
const db = createDb(config.PROBLEMS_DATABASE_URL, 1);

try {
  const { error, results = [] } = await migrateToLatest(db);
  for (const r of results)
    logger.info({ migration: r.migrationName, status: r.status }, 'migración');
  if (results.length === 0) logger.info('sin migraciones pendientes');
  if (error) {
    logger.error({ err: error }, 'falló la migración');
    process.exitCode = 1;
  }
} finally {
  await db.destroy();
}
