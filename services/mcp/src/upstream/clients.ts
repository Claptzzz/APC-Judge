import { createClient } from '@connectrpc/connect';
import type { CallOptions, Client } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { AUTH_METADATA_KEY } from '@juez/contracts';
import { ProblemService, RankingService, SubmissionService } from '@juez/contracts/es';

export const REQUEST_ID_HEADER = 'x-request-id';
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 3_000;

/**
 * Subconjunto de los clientes Connect que usan las tools (solo lectura). Tipado con los
 * clientes reales para que los fakes de los tests no puedan desviarse del contrato.
 */
export interface UpstreamClients {
  problems: Pick<Client<typeof ProblemService>, 'listProblems' | 'getProblem'>;
  submissions: Pick<Client<typeof SubmissionService>, 'listSubmissions' | 'getSubmission'>;
  ranking: Pick<Client<typeof RankingService>, 'getScoreboard'>;
}

export function createUpstreamClients(baseUrls: {
  problems: string;
  submissions: string;
  ranking: string;
}): UpstreamClients {
  // gRPC sobre HTTP/2 sin TLS (h2c) en local y dentro del cluster.
  return {
    problems: createClient(ProblemService, createGrpcTransport({ baseUrl: baseUrls.problems })),
    submissions: createClient(
      SubmissionService,
      createGrpcTransport({ baseUrl: baseUrls.submissions }),
    ),
    ranking: createClient(RankingService, createGrpcTransport({ baseUrl: baseUrls.ranking })),
  };
}

/**
 * Opciones de cada llamada Connect: propaga el JWT del usuario en `authorization` (nunca
 * credenciales propias), el `x-request-id` y un timeout por llamada.
 */
export function callOptions(
  ctx: { token: string; requestId: string },
  timeoutMs: number,
): CallOptions {
  return {
    timeoutMs,
    headers: {
      [AUTH_METADATA_KEY]: `Bearer ${ctx.token}`,
      [REQUEST_ID_HEADER]: ctx.requestId,
    },
  };
}
