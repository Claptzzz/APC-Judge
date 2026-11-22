import { CombinedGraphQLErrors, ServerError, ServerParseError } from '@apollo/client/errors';

/**
 * Códigos de `errors[].extensions.code` del contrato, más dos del asistente que el BFF puede
 * devolver aunque el schema todavía no los documenta (`ASSISTANT_DISABLED` y el rate limit).
 */
export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'BAD_USER_INPUT'
  | 'CONFLICT'
  | 'UNAVAILABLE'
  | 'INTERNAL_SERVER_ERROR'
  | 'ASSISTANT_DISABLED'
  | 'RATE_LIMITED'
  | 'NETWORK'
  | 'UNKNOWN';

const RATE_LIMIT_ALIASES = new Set(['RATE_LIMITED', 'TOO_MANY_REQUESTS', 'RATE_LIMIT_EXCEEDED']);

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  UNAUTHENTICATED: 'Tu sesión expiró o no es válida. Inicia sesión nuevamente.',
  FORBIDDEN: 'No tienes permisos para realizar esta acción.',
  NOT_FOUND: 'No encontramos lo que buscas.',
  BAD_USER_INPUT: 'Hay datos inválidos. Revisa el formulario.',
  CONFLICT: 'Ya existe un registro con esos datos.',
  UNAVAILABLE: 'El servicio no está disponible, intenta en un momento.',
  INTERNAL_SERVER_ERROR: 'Ocurrió un error inesperado. Intenta nuevamente.',
  ASSISTANT_DISABLED: 'El asistente está deshabilitado por ahora. Vuelve a intentarlo más tarde.',
  RATE_LIMITED: 'Hiciste demasiadas solicitudes seguidas. Espera un momento antes de reintentar.',
  NETWORK: 'No pudimos conectar con el servidor. Revisa tu conexión e intenta de nuevo.',
  UNKNOWN: 'Ocurrió un error inesperado. Intenta nuevamente.',
};

export interface DescribedError {
  code: ErrorCode;
  message: string;
  /** Mensaje original del servidor (útil para BAD_USER_INPUT), si lo hay. */
  detail?: string;
  /** Segundos sugeridos antes de reintentar (rate limit), si el servidor los indica. */
  retryAfterSeconds?: number;
}

function normalizeCode(raw: unknown): ErrorCode {
  if (typeof raw !== 'string') return 'UNKNOWN';
  const code = raw.toUpperCase();
  if (RATE_LIMIT_ALIASES.has(code)) return 'RATE_LIMITED';
  if (code in ERROR_MESSAGES) return code as ErrorCode;
  return 'UNKNOWN';
}

function readRetryAfter(extensions: Record<string, unknown> | undefined): number | undefined {
  const value = extensions?.retryAfterSeconds ?? extensions?.retryAfter;
  return typeof value === 'number' && value > 0 ? Math.ceil(value) : undefined;
}

/** Código principal de un error de Apollo (o `UNKNOWN`). */
export function errorCode(error: unknown): ErrorCode {
  return describeError(error).code;
}

/**
 * Traduce un error de Apollo a un mensaje entendible. `overrides` permite mensajes propios
 * de una pantalla (p. ej. credenciales incorrectas en el login).
 */
export function describeError(
  error: unknown,
  overrides: Partial<Record<ErrorCode, string>> = {},
): DescribedError {
  if (CombinedGraphQLErrors.is(error)) {
    const first = error.errors[0];
    const extensions = first?.extensions as Record<string, unknown> | undefined;
    const code = normalizeCode(extensions?.code);
    const result: DescribedError = {
      code,
      message: overrides[code] ?? ERROR_MESSAGES[code],
    };
    if (first?.message) result.detail = first.message;
    const retry = readRetryAfter(extensions);
    if (retry !== undefined) result.retryAfterSeconds = retry;
    return result;
  }
  if (ServerError.is(error)) {
    const code: ErrorCode =
      error.statusCode === 429
        ? 'RATE_LIMITED'
        : error.statusCode === 401
          ? 'UNAUTHENTICATED'
          : error.statusCode >= 500
            ? 'UNAVAILABLE'
            : 'UNKNOWN';
    return { code, message: overrides[code] ?? ERROR_MESSAGES[code] };
  }
  if (ServerParseError.is(error)) {
    return { code: 'UNAVAILABLE', message: overrides.UNAVAILABLE ?? ERROR_MESSAGES.UNAVAILABLE };
  }
  if (
    error instanceof TypeError ||
    (error instanceof Error && /network|fetch|socket/i.test(error.message))
  ) {
    return { code: 'NETWORK', message: overrides.NETWORK ?? ERROR_MESSAGES.NETWORK };
  }
  return { code: 'UNKNOWN', message: overrides.UNKNOWN ?? ERROR_MESSAGES.UNKNOWN };
}
