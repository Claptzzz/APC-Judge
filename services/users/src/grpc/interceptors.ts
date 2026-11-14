import { randomUUID } from 'node:crypto';
import { Code, ConnectError } from '@connectrpc/connect';
import type { Interceptor } from '@connectrpc/connect';
import type { Logger } from '../logger.js';
import type { Metrics } from '../metrics.js';
import { kLogger, kRequestId, REQUEST_ID_HEADER } from './context.js';

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** Usa el x-request-id entrante si es válido; si no, genera uno. */
export function resolveRequestId(value: string | null): string {
  return value && REQUEST_ID_RE.test(value) ? value : randomUUID();
}

/** `Code.AlreadyExists` -> `already_exists` (nombres canónicos de gRPC/Connect). */
export function codeName(code: Code): string {
  const name = Code[code] as string | undefined;
  if (!name) return 'unknown';
  return name.replace(/[A-Z]/g, (c, i: number) => (i ? '_' : '') + c.toLowerCase());
}

/**
 * Interceptor de servidor:
 * - propaga `x-request-id` (lo devuelve en la respuesta y en los errores) y deja en el
 *   contexto un logger hijo con requestId y nombre de la RPC;
 * - registra cada RPC (código y duración) en logs y métricas;
 * - oculta los mensajes de errores inesperados detrás de `internal`.
 */
export function requestContextInterceptor(logger: Logger, metrics?: Metrics): Interceptor {
  return (next) => async (req) => {
    const requestId = resolveRequestId(req.header.get(REQUEST_ID_HEADER));
    const log = logger.child({ requestId, rpc: req.method.name });
    req.contextValues.set(kRequestId, requestId);
    req.contextValues.set(kLogger, log);
    const started = performance.now();
    const finish = (code: string) => {
      const durationMs = performance.now() - started;
      metrics?.rpcDuration.observe({ method: req.method.name, code }, durationMs / 1000);
      return Math.round(durationMs * 10) / 10;
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
        log.info({ code, durationMs: finish(code) }, error.rawMessage);
      } else {
        error = new ConnectError('Error interno', Code.Internal);
        log.error({ err, code: 'internal', durationMs: finish('internal') }, 'rpc falló');
      }
      error.metadata.set(REQUEST_ID_HEADER, requestId);
      throw error;
    }
  };
}
