import { Code, ConnectError } from '@connectrpc/connect';
import type { Client, Transport } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import type { GetJudgeSpecResponse, ProblemService } from '@juez/contracts/es';
import type { Logger } from './logger.js';
import { withRetry } from './retry.js';
import type { RetryOptions } from './retry.js';

export type ProblemsClient = Client<typeof ProblemService>;

/** Origen de los JudgeSpec (abstracción para mockear problems en los tests). */
export interface JudgeSpecSource {
  getJudgeSpec(problemId: string, requestId: string): Promise<GetJudgeSpecResponse>;
}

export const REQUEST_ID_HEADER = 'x-request-id';

/** Códigos gRPC que se consideran transitorios (vale la pena reintentar). */
const RETRYABLE_CODES = new Set<Code>([
  Code.Unavailable,
  Code.DeadlineExceeded,
  Code.ResourceExhausted,
  Code.Aborted,
  Code.Internal,
  Code.Unknown,
]);

export function isRetryableRpcError(error: unknown): boolean {
  return RETRYABLE_CODES.has(ConnectError.from(error).code);
}

export function createProblemsTransport(baseUrl: string): Transport {
  // gRPC sobre HTTP/2 sin TLS (h2c) en local y dentro del cluster.
  return createGrpcTransport({ baseUrl });
}

export interface JudgeSpecSourceOptions {
  timeoutMs?: number;
  retry?: Partial<RetryOptions>;
  logger?: Logger;
}

/** GetJudgeSpec con timeout por llamada, `x-request-id` y reintentos en errores transitorios. */
export function createJudgeSpecSource(
  client: ProblemsClient,
  options: JudgeSpecSourceOptions = {},
): JudgeSpecSource {
  const { timeoutMs = 5_000, logger } = options;
  return {
    getJudgeSpec(problemId, requestId) {
      return withRetry(
        () =>
          client.getJudgeSpec(
            { problemId },
            { timeoutMs, headers: { [REQUEST_ID_HEADER]: requestId } },
          ),
        {
          attempts: 4,
          baseDelayMs: 250,
          maxDelayMs: 2_000,
          isRetryable: isRetryableRpcError,
          onRetry: (error, attempt, delayMs) =>
            logger?.warn(
              { err: error, attempt, delayMs, problemId, requestId },
              'GetJudgeSpec falló; reintentando',
            ),
          ...options.retry,
        },
      );
    },
  };
}
