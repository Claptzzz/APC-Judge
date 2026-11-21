import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Db = PostgresJsDatabase<typeof schema>;

export interface Database {
  db: Db;
  /** Comprueba que la BD responde (para /ready). */
  ping(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

/**
 * Pool de postgres.js. No conecta al crearse: la primera consulta abre la conexión, así que
 * el servicio arranca aunque Postgres no esté disponible (y /ready lo refleja).
 */
export function createDatabase(url: string, opts: { max?: number } = {}): Database {
  const sql = postgres(url, {
    max: opts.max ?? 10,
    onnotice: () => {},
    connect_timeout: 5,
    connection: { application_name: 'juez-ranking' },
  });
  const db = drizzle(sql, { schema });
  return {
    db,
    async ping(timeoutMs = 2000) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`BD sin respuesta en ${timeoutMs} ms`)),
          timeoutMs,
        );
      });
      try {
        await Promise.race([sql`select 1`, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
    close: () => sql.end({ timeout: 5 }),
  };
}
