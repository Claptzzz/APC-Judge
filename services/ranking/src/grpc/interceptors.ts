import { randomUUID } from 'node:crypto';
import { Code, ConnectError, createContextKey } from '@connectrpc/connect';
import type { Interceptor } from '@connectrpc/connect';
import type { Logger } from '../logger.js';
import type { Metrics } from '../metrics.js';

export const REQUEST_ID_HEADER = 'x-request-id';
export const kRequestId = createContextKey<string>('', { description: 'x-request-id de la RPC' });

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** Usa el x-request-id entrante si es válido; si no, genera uno. */
export function resolveRequestId(value: string | null): string {
  return value && REQUEST_ID_RE.test(value) ? value : randomUUID();
}

/** `Code.NotFound` -> `not_found`. */
export function codeName(code: Code): string {
  const name = Code[code] as string | undefined;
  if (!name) return 'unknown';
  return name.replace(/[A-Z]/g, (c, i: number) => (i ? '_' : '') + c.toLowerCase());
}

/**
 * - Propaga `x-request-id` (contexto, respuesta y errores).
 * - Registra cada RPC (código y duración) en logs y métricas.
 * - Oculta los errores no controlados detrás de `internal`.
 */
export function requestContextInterceptor(logger: Logger, metrics?: Metrics): Interceptor {
  return (next) => async (req) => {
    const requestId = resolveRequestId(req.header.get(REQUEST_ID_HEADER));
    req.contextValues.set(kRequestId, requestId);
    const log = logger.child({ requestId, rpc: req.method.name });
    const started = performance.now();
    const finish = (code: string) => {
      const ms = performance.now() - started;
      metrics?.rpcDuration.observe({ method: req.method.name, code }, ms / 1000);
      return Math.round(ms * 10) / 10;
    };
    try {
      const res = await next(req);
      res.header.set(REQUEST_ID_HEADER, requestId);
      log.info({ code: 'ok', durationMs: finish('ok') }, 'rpc');
      return res;
    } catch (err) {
      let error: ConnectError;
      if (err instanceof ConnectError) {
        error = err;
        const code = codeName(error.code);
        const fields = { code, durationMs: finish(code), reason: error.rawMessage };
        if (error.code === Code.Internal || error.code === Code.Unavailable) {
          log.error({ ...fields, err: error.cause ?? error }, 'rpc');
        } else {
          log.info(fields, 'rpc');
        }
      } else {
        error = new ConnectError('error interno', Code.Internal);
        log.error({ err, code: 'internal', durationMs: finish('internal') }, 'rpc falló');
      }
      error.metadata.set(REQUEST_ID_HEADER, requestId);
      throw error;
    }
  };
}
