import type { problems, ranking, users } from '@juez/contracts/nest';
import DataLoader from 'dataloader';
import type { Backend, CallMeta } from '../grpc/backend.js';
import { isNotFound } from '../grpc/errors.js';

/** DataLoaders de un request (u operación WS): deduplican y agrupan las relaciones. */
export interface Loaders {
  /** `null` si el usuario no existe. Una sola llamada `GetUsers` por tick. */
  users: DataLoader<string, users.User | null>;
  /** `null` si el problema no existe o quien consulta no puede verlo. */
  problems: DataLoader<string, problems.Problem | null>;
  /** `null` si el contest no existe. */
  contests: DataLoader<string, ranking.Contest | null>;
}

/** Ejecuta `fn` por id (deduplicado por DataLoader); NOT_FOUND → null, otro error → Error. */
async function perKey<T>(
  ids: readonly string[],
  fn: (id: string) => Promise<T | undefined>,
): Promise<Array<T | null | Error>> {
  return Promise.all(
    ids.map(async (id) => {
      try {
        return (await fn(id)) ?? null;
      } catch (err) {
        if (isNotFound(err)) return null;
        return err instanceof Error ? err : new Error(String(err));
      }
    }),
  );
}

export function createLoaders(backend: Backend, meta: CallMeta): Loaders {
  return {
    users: new DataLoader(
      async (ids) => {
        const res = await backend.users.getUsers({ ids: [...ids] }, meta);
        const byId = new Map((res.users ?? []).map((u) => [u.id, u]));
        return ids.map((id) => byId.get(id) ?? null);
      },
      { maxBatchSize: 100 },
    ),
    problems: new DataLoader(
      (ids) => perKey(ids, async (id) => (await backend.problems.getProblem({ id }, meta)).problem),
      { maxBatchSize: 50 },
    ),
    contests: new DataLoader(
      (ids) => perKey(ids, async (id) => (await backend.ranking.getContest({ id }, meta)).contest),
      { maxBatchSize: 50 },
    ),
  };
}
