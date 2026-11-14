// db:seed — siembra 3 problemas de ejemplo con sus casos en MinIO (idempotente).
// Requiere haber corrido db:migrate.
import { parseConfig, seedConfigSchema } from '../config.js';
import { createDb } from '../db/database.js';
import { createLogger } from '../logger.js';
import { runSeed } from '../seed/run-seed.js';
import { S3TestcaseStorage } from '../storage/testcase-storage.js';

const config = parseConfig(seedConfigSchema, process.env);
const logger = createLogger(config.LOG_LEVEL);
const db = createDb(config.PROBLEMS_DATABASE_URL, 2);
const storage = S3TestcaseStorage.fromConfig(config);

try {
  const results = await runSeed({ db, storage, logger });
  logger.info({ problems: results }, 'seed completo');
} catch (err) {
  logger.error({ err }, 'falló el seed');
  process.exitCode = 1;
} finally {
  await db.destroy();
  storage.destroy();
}
