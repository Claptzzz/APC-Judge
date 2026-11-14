import { Code, ConnectError } from '@connectrpc/connect';
import type { AdminBootstrap } from './config.js';
import type { Logger } from './logger.js';
import { registerUser } from './register.js';
import type { RegisterDeps } from './register.js';

export type BootstrapResult = 'created' | 'exists' | 'skipped';

/**
 * Crea el usuario ADMIN inicial si no existe. Idempotente: si el username o el email ya
 * existen no modifica nada (tampoco cambia el rol ni la contraseña de un usuario existente).
 */
export async function ensureAdmin(
  deps: RegisterDeps & { logger: Logger },
  admin: AdminBootstrap | undefined,
): Promise<BootstrapResult> {
  if (!admin) {
    deps.logger.info('admin inicial no configurado (USERS_ADMIN_*); se omite');
    return 'skipped';
  }
  try {
    const user = await registerUser(deps, admin, 'ADMIN');
    deps.logger.info({ userId: user.id, username: user.username }, 'admin inicial creado');
    return 'created';
  } catch (err) {
    if (err instanceof ConnectError && err.code === Code.AlreadyExists) {
      deps.logger.info({ username: admin.username }, 'admin inicial ya existe; sin cambios');
      return 'exists';
    }
    if (err instanceof ConnectError && err.code === Code.InvalidArgument) {
      throw new Error(`USERS_ADMIN_* inválidas: ${err.rawMessage}`, { cause: err });
    }
    throw err;
  }
}
