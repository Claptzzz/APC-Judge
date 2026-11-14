import { Code, ConnectError } from '@connectrpc/connect';
import { z } from 'zod';

export const USERNAME_RE = /^[A-Za-z0-9_-]{3,32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MAX_BATCH_IDS = 1000;

export const registerInput = z.object({
  username: z
    .string()
    .trim()
    .regex(USERNAME_RE, 'username: 3 a 32 caracteres; letras, números, "_" o "-"'),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email('email inválido').max(254, 'email demasiado largo')),
  password: z
    .string()
    .min(8, 'password: mínimo 8 caracteres')
    .max(128, 'password: máximo 128 caracteres'),
});

export type RegisterInput = z.infer<typeof registerInput>;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Valida con zod y traduce los errores a `invalid_argument`. */
export function parseOrInvalid<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ConnectError(
      result.error.issues.map((i) => i.message).join('; '),
      Code.InvalidArgument,
    );
  }
  return result.data;
}
