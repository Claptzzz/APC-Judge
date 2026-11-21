import { Code, ConnectError } from '@connectrpc/connect';

/** Servicio de origen de un error, con el nombre que entiende el usuario final. */
export type UpstreamService = 'users' | 'problems' | 'submissions' | 'ranking';

export const SERVICE_LABEL: Record<UpstreamService, string> = {
  users: 'usuarios',
  problems: 'problemas',
  submissions: 'submissions',
  ranking: 'ranking',
};

export type UpstreamFailure =
  | 'not_found'
  | 'unavailable'
  | 'invalid_argument'
  | 'permission_denied'
  | 'unauthenticated'
  | 'failed_precondition'
  | 'other';

/** Códigos de error de red de Node (sockets / DNS / HTTP2) que indican que el servicio no responde. */
const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ERR_HTTP2_STREAM_ERROR',
  'ERR_HTTP2_SESSION_ERROR',
  'ERR_HTTP2_GOAWAY_SESSION',
  'ERR_HTTP2_STREAM_CANCEL',
]);

function isNetworkError(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== 'object' || depth > 5) return false;
  const { code, cause } = err as { code?: unknown; cause?: unknown };
  if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) return true;
  return isNetworkError(cause, depth + 1);
}

/**
 * Clasifica un error de un cliente Connect. `NotFound` → not_found; `Unavailable`,
 * `DeadlineExceeded` o un error de red → unavailable (nunca "no existe" si el servicio no
 * responde).
 */
export function classifyUpstreamError(err: unknown): UpstreamFailure {
  if (err instanceof ConnectError) {
    switch (err.code) {
      case Code.NotFound:
        return 'not_found';
      case Code.Unavailable:
      case Code.DeadlineExceeded:
        return 'unavailable';
      case Code.InvalidArgument:
        return 'invalid_argument';
      case Code.PermissionDenied:
        return 'permission_denied';
      case Code.Unauthenticated:
        return 'unauthenticated';
      case Code.FailedPrecondition:
        return 'failed_precondition';
      default:
        // Connect envuelve fallos de transporte como Unknown/Internal con la causa original.
        return isNetworkError(err.cause) ? 'unavailable' : 'other';
    }
  }
  return isNetworkError(err) ? 'unavailable' : 'other';
}

/**
 * Mensaje en español, pensado para que el LLM entienda qué pasó y pueda reaccionar
 * (reintentar, pedir otro dato al usuario o explicarle el problema).
 */
export function describeUpstreamError(
  err: unknown,
  service: UpstreamService,
  notFoundMessage: string,
): string {
  const label = SERVICE_LABEL[service];
  const detail = err instanceof ConnectError ? err.rawMessage : undefined;
  switch (classifyUpstreamError(err)) {
    case 'not_found':
      return notFoundMessage;
    case 'unavailable':
      return `El servicio de ${label} no responde en este momento. Intenta de nuevo en unos segundos.`;
    case 'invalid_argument':
      return `El servicio de ${label} rechazó los argumentos${detail ? `: ${detail}` : '.'}`;
    case 'permission_denied':
      return `El usuario no tiene permiso para ver esto en el servicio de ${label}.`;
    case 'unauthenticated':
      return `El servicio de ${label} rechazó la sesión del usuario (token inválido o expirado).`;
    case 'failed_precondition':
      return `El servicio de ${label} no puede responder a esto ahora${detail ? `: ${detail}` : '.'}`;
    default:
      return `Error inesperado en el servicio de ${label}.`;
  }
}
