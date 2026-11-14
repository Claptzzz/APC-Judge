import { Code, ConnectError } from '@connectrpc/connect';
import { hashPassword } from './auth/password.js';
import type { RoleName } from './db/schema.js';
import { DuplicateUserError } from './repository.js';
import type { UserRecord, UsersRepository } from './repository.js';
import { parseOrInvalid, registerInput } from './validation.js';

const DUPLICATE_MESSAGES = {
  username: 'El username ya está en uso',
  email: 'El email ya está registrado',
} as const;

export interface RegisterDeps {
  repo: UsersRepository;
  hash?: (password: string) => Promise<string>;
}

/**
 * Valida, hashea y crea el usuario (con su evento en el outbox). Errores:
 * `invalid_argument` si los datos no son válidos y `already_exists` si el username
 * (sin distinguir mayúsculas) o el email ya existen.
 */
export async function registerUser(
  deps: RegisterDeps,
  input: { username: string; email: string; password: string },
  role: RoleName = 'CONTESTANT',
): Promise<UserRecord> {
  const data = parseOrInvalid(registerInput, input);
  const passwordHash = await (deps.hash ?? hashPassword)(data.password);
  try {
    return await deps.repo.createWithRegisteredEvent({
      username: data.username,
      email: data.email,
      passwordHash,
      role,
    });
  } catch (err) {
    if (err instanceof DuplicateUserError) {
      throw new ConnectError(DUPLICATE_MESSAGES[err.field], Code.AlreadyExists);
    }
    throw err;
  }
}
