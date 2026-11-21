import { Code, ConnectError, createClient } from '@connectrpc/connect';
import type { Client } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { AUTH_METADATA_KEY } from '@juez/contracts';
import { ProblemService } from '@juez/contracts/es';
import { UPSTREAM_TIMEOUT_MS } from '../auth/jwt.js';

export const REQUEST_ID_HEADER = 'x-request-id';

export type UpstreamFailure = 'not_found' | 'unavailable' | 'other';

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
 * Clasifica el error de una llamada a otro servicio: `NotFound` -> no existe;
 * `Unavailable`, `DeadlineExceeded` o un error de red -> no responde. Nunca se reporta
 * "no existe" cuando lo que pasa es que el servicio no responde.
 */
export function classifyUpstreamError(err: unknown): UpstreamFailure {
  if (err instanceof ConnectError) {
    if (err.code === Code.NotFound) return 'not_found';
    if (err.code === Code.Unavailable || err.code === Code.DeadlineExceeded) return 'unavailable';
    return isNetworkError(err.cause) ? 'unavailable' : 'other';
  }
  return isNetworkError(err) ? 'unavailable' : 'other';
}

export interface CallContext {
  /** Valor de `authorization` de la RPC entrante (se propaga tal cual). */
  authorization: string | null;
  requestId: string;
}

export interface ProblemsGateway {
  /** Lanza ConnectError NOT_FOUND / UNAVAILABLE / INTERNAL si algún problema no se puede validar. */
  assertProblemsExist(problemIds: readonly string[], ctx: CallContext): Promise<void>;
}

export class ConnectProblemsGateway implements ProblemsGateway {
  constructor(
    private readonly client: Client<typeof ProblemService>,
    private readonly timeoutMs = UPSTREAM_TIMEOUT_MS,
  ) {}

  static fromBaseUrl(baseUrl: string): ConnectProblemsGateway {
    return new ConnectProblemsGateway(
      createClient(ProblemService, createGrpcTransport({ baseUrl })),
    );
  }

  async assertProblemsExist(problemIds: readonly string[], ctx: CallContext): Promise<void> {
    const headers: Record<string, string> = { [REQUEST_ID_HEADER]: ctx.requestId };
    if (ctx.authorization) headers[AUTH_METADATA_KEY] = ctx.authorization;
    const results = await Promise.allSettled(
      problemIds.map(async (id) => {
        const res = await this.client.getProblem(
          { key: { case: 'id', value: id } },
          { headers, timeoutMs: this.timeoutMs },
        );
        if (!res.problem) throw new ConnectError(`problema ${id} no encontrado`, Code.NotFound);
      }),
    );
    const failures = results.flatMap((r, i) =>
      r.status === 'rejected' ? [{ id: problemIds[i]!, err: r.reason as unknown }] : [],
    );
    if (failures.length === 0) return;
    // Prioridad: si problems no responde no podemos afirmar que algo no exista.
    const classified = failures.map((f) => ({ ...f, kind: classifyUpstreamError(f.err) }));
    if (classified.some((f) => f.kind === 'unavailable')) {
      throw new ConnectError(
        'el servicio problems no responde; intenta de nuevo más tarde',
        Code.Unavailable,
      );
    }
    const other = classified.find((f) => f.kind === 'other');
    if (other) {
      throw new ConnectError(
        `error al validar el problema ${other.id}`,
        Code.Internal,
        undefined,
        undefined,
        other.err,
      );
    }
    const missing = classified.map((f) => f.id);
    throw new ConnectError(`problemas inexistentes: ${missing.join(', ')}`, Code.NotFound);
  }
}
