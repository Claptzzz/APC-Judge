import { Code, ConnectError } from '@connectrpc/connect';

/** Timeout por llamada a problems / ranking. */
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 3_000;

export type UpstreamFailure = 'not_found' | 'unavailable' | 'other';

/** Códigos de error de red de Node (sockets / DNS) que indican que el servicio no responde. */
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

/** Clasifica un error de un cliente Connect para decidir el código gRPC que devolvemos. */
export function classifyUpstreamError(err: unknown): UpstreamFailure {
  if (err instanceof ConnectError) {
    if (err.code === Code.NotFound) return 'not_found';
    if (err.code === Code.Unavailable || err.code === Code.DeadlineExceeded) return 'unavailable';
    // Connect envuelve fallos de transporte desconocidos como Unknown/Internal con la causa.
    return isNetworkError(err.cause) ? 'unavailable' : 'other';
  }
  return isNetworkError(err) ? 'unavailable' : 'other';
}
