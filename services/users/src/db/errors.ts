/** Busca en la cadena de `cause` un error de Postgres por violación de unicidad (23505). */
export function findUniqueViolation(err: unknown): { constraint: string | undefined } | undefined {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    const e = current as { code?: unknown; constraint_name?: unknown; cause?: unknown };
    if (e.code === '23505') {
      return { constraint: typeof e.constraint_name === 'string' ? e.constraint_name : undefined };
    }
    current = e.cause;
  }
  return undefined;
}
