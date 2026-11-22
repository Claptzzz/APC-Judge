import { status as GrpcStatus } from '@grpc/grpc-js';
import { GraphQLError } from 'graphql';

/** Códigos de `errors[].extensions.code` (ver la descripción del schema). */
export const ErrorCode = {
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  BAD_USER_INPUT: 'BAD_USER_INPUT',
  CONFLICT: 'CONFLICT',
  UNAVAILABLE: 'UNAVAILABLE',
  INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR',
  /** `askAssistant` sin configuración de Gemini. */
  ASSISTANT_DISABLED: 'ASSISTANT_DISABLED',
  /** `askAssistant` superó el límite por usuario. */
  RATE_LIMITED: 'RATE_LIMITED',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export function gqlError(
  code: ErrorCode,
  message: string,
  extensions: Record<string, unknown> = {},
): GraphQLError {
  return new GraphQLError(message, { extensions: { ...extensions, code } });
}

export type ServiceName = 'users' | 'problems' | 'submissions' | 'ranking';

const SERVICE_LABEL: Record<ServiceName, string> = {
  users: 'usuarios',
  problems: 'problemas',
  submissions: 'submissions',
  ranking: 'ranking',
};

/** Código gRPC → código GraphQL. Lo que no aparece aquí es INTERNAL_SERVER_ERROR. */
const GRPC_TO_GQL: Partial<Record<GrpcStatus, ErrorCode>> = {
  [GrpcStatus.NOT_FOUND]: ErrorCode.NOT_FOUND,
  [GrpcStatus.UNAVAILABLE]: ErrorCode.UNAVAILABLE,
  [GrpcStatus.DEADLINE_EXCEEDED]: ErrorCode.UNAVAILABLE,
  [GrpcStatus.CANCELLED]: ErrorCode.UNAVAILABLE,
  [GrpcStatus.RESOURCE_EXHAUSTED]: ErrorCode.UNAVAILABLE,
  [GrpcStatus.UNAUTHENTICATED]: ErrorCode.UNAUTHENTICATED,
  [GrpcStatus.PERMISSION_DENIED]: ErrorCode.FORBIDDEN,
  [GrpcStatus.INVALID_ARGUMENT]: ErrorCode.BAD_USER_INPUT,
  [GrpcStatus.FAILED_PRECONDITION]: ErrorCode.BAD_USER_INPUT,
  [GrpcStatus.OUT_OF_RANGE]: ErrorCode.BAD_USER_INPUT,
  [GrpcStatus.ALREADY_EXISTS]: ErrorCode.CONFLICT,
};

/** Códigos de error de red de Node: el servicio no responde. */
const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
]);

/**
 * Error de una llamada gRPC ya traducido al contrato GraphQL (`extensions.code`). Conserva
 * el código gRPC para que los resolvers puedan, p. ej., devolver `null` ante NOT_FOUND.
 */
export class UpstreamError extends GraphQLError {
  constructor(
    readonly service: ServiceName,
    readonly grpcCode: GrpcStatus,
    message: string,
    code: ErrorCode,
  ) {
    super(message, { extensions: { code } });
    this.name = 'UpstreamError';
  }

  get code(): ErrorCode {
    return this.extensions.code as ErrorCode;
  }
}

interface GrpcLikeError {
  code?: unknown;
  details?: unknown;
  name?: unknown;
  message?: unknown;
}

/** Traduce el error de una llamada gRPC (o de red / timeout local) a `UpstreamError`. */
export function fromGrpcError(service: ServiceName, err: unknown): UpstreamError {
  if (err instanceof UpstreamError) return err;
  const e = (err ?? {}) as GrpcLikeError;
  const label = SERVICE_LABEL[service];

  let grpcCode: GrpcStatus;
  if (typeof e.code === 'number' && e.code in GrpcStatus) {
    grpcCode = e.code as GrpcStatus;
  } else if (
    e.name === 'TimeoutError' ||
    (typeof e.code === 'string' && NETWORK_ERROR_CODES.has(e.code))
  ) {
    grpcCode = GrpcStatus.UNAVAILABLE;
  } else {
    grpcCode = GrpcStatus.UNKNOWN;
  }

  const code = GRPC_TO_GQL[grpcCode] ?? ErrorCode.INTERNAL_SERVER_ERROR;
  const details = typeof e.details === 'string' && e.details ? e.details : undefined;
  let message: string;
  switch (code) {
    case ErrorCode.UNAVAILABLE:
      message = `El servicio de ${label} no responde en este momento; reintenta más tarde.`;
      break;
    case ErrorCode.INTERNAL_SERVER_ERROR:
      // No se filtran detalles internos del servicio al cliente.
      message = `Error interno en el servicio de ${label}.`;
      break;
    case ErrorCode.NOT_FOUND:
      message = details ?? 'El recurso no existe.';
      break;
    default:
      message = details ?? `El servicio de ${label} rechazó la operación.`;
  }
  return new UpstreamError(service, grpcCode, message, code);
}

export function isNotFound(err: unknown): boolean {
  return err instanceof UpstreamError && err.code === ErrorCode.NOT_FOUND;
}
