import { randomUUID } from 'node:crypto';
import { Code, ConnectError, createContextKey, type Interceptor } from '@connectrpc/connect';
import type { Logger } from '../logger.js';
import type { Metrics } from '../metrics.js';

export const REQUEST_ID_HEADER = 'x-request-id';
export const requestIdKey = createContextKey<string>('', { description: 'x-request-id de la RPC' });

const REQUEST_ID_PATTERN = /^[\w.:-]{1,128}$/;

/**
 * Toma (o genera) `x-request-id`, lo deja en el contexto y lo devuelve en la respuesta,
 * registra cada RPC en el log JSON y en las métricas, y oculta los errores no controlados
 * tras un `Internal` genérico.
 */
export function observabilityInterceptor(logger: Logger, metrics?: Metrics): Interceptor {
  return (next) => async (req) => {
    const incoming = req.header.get(REQUEST_ID_HEADER);
    const requestId = incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
    req.contextValues.set(requestIdKey, requestId);
    const method = `${req.service.typeName}/${req.method.name}`;
    const log = logger.child({ requestId, method });
    const stopTimer = metrics?.rpcDuration.startTimer({ method });
    try {
      const res = await next(req);
      res.header.set(REQUEST_ID_HEADER, requestId);
      metrics?.rpcHandled.inc({ method, code: 'ok' });
      log.info({ code: 'ok' }, 'rpc');
      return res;
    } catch (err) {
      let error = ConnectError.from(err);
      if (!(err instanceof ConnectError)) {
        log.error({ err }, 'error no controlado en la RPC');
        error = new ConnectError('error interno', Code.Internal);
      }
      error.metadata.set(REQUEST_ID_HEADER, requestId);
      const code = Code[error.code];
      metrics?.rpcHandled.inc({ method, code });
      if (error.code === Code.Internal || error.code === Code.Unavailable) {
        log.error({ code, err: error }, 'rpc');
      } else {
        log.info({ code, reason: error.rawMessage }, 'rpc');
      }
      throw error;
    } finally {
      stopTimer?.();
    }
  };
}
