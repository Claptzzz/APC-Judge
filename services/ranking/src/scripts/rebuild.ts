// pnpm scoreboard:rebuild [contest_id…]: regenera la proyección de Redis desde Postgres.
// Sin argumentos reconstruye todos los contests.
import { z } from 'zod';
import { createDatabase } from '../db/client.js';
import { isUuid } from '../domain/contest.js';
import { createLogger } from '../logger.js';
import { ScoreboardProjector } from '../projection/projector.js';
import { createRedis, ioredisAdapter } from '../projection/redis.js';
import { ScoreboardStore } from '../projection/scoreboard-store.js';
import { DrizzleRankingRepository } from '../repository.js';

const logger = createLogger(process.env.LOG_LEVEL ?? 'info').child({ component: 'rebuild' });
const env = z
  .object({
    RANKING_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    RANKING_REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  })
  .safeParse(process.env);
if (!env.success) {
  logger.fatal({ issues: env.error.issues }, 'RANKING_DATABASE_URL / RANKING_REDIS_URL inválidas');
  process.exit(1);
}

const ids = process.argv.slice(2);
const invalid = ids.filter((id) => !isUuid(id));
if (invalid.length > 0) {
  logger.fatal({ invalid }, 'los contest_id deben ser UUID');
  process.exit(1);
}

const database = createDatabase(env.data.RANKING_DATABASE_URL, { max: 2 });
const redis = createRedis(env.data.RANKING_REDIS_URL, logger);
const projector = new ScoreboardProjector(
  new DrizzleRankingRepository(database.db),
  new ScoreboardStore(ioredisAdapter(redis)),
  logger,
);

try {
  // Sin cola offline: esperar a que Redis esté listo antes de escribir.
  if (redis.status !== 'ready') {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('redis no respondió en 10 s')), 10_000);
      redis.once('ready', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  if (ids.length === 0) {
    const n = await projector.rebuildAll();
    logger.info({ contests: n }, 'proyección reconstruida');
  } else {
    for (const id of ids) {
      const found = await projector.rebuildContest(id);
      logger.info({ contestId: id, found }, found ? 'contest reconstruido' : 'contest no existe');
    }
  }
} catch (err) {
  logger.fatal({ err }, 'error al reconstruir la proyección');
  process.exitCode = 1;
} finally {
  projector.stop();
  redis.disconnect();
  await database.close();
}
