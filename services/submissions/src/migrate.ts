import { z } from 'zod';
import { createDatabase } from './db/client.js';
import { MIGRATIONS_DIR, runMigrations } from './db/migrate.js';
import { createLogger } from './logger.js';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info').child({ component: 'migrate' });
const url = z
  .string()
  .regex(/^postgres(ql)?:\/\//)
  .safeParse(process.env.SUBMISSIONS_DATABASE_URL);
if (!url.success) {
  logger.fatal('SUBMISSIONS_DATABASE_URL no definida o inválida');
  process.exit(1);
}

const database = createDatabase(url.data, { max: 1 });
try {
  await runMigrations(database.db);
  logger.info({ folder: MIGRATIONS_DIR }, 'migraciones aplicadas');
} catch (err) {
  logger.fatal({ err }, 'error al migrar');
  process.exitCode = 1;
} finally {
  await database.close();
}
