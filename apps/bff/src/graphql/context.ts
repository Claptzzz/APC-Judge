import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { GraphQLError } from 'graphql';
import { InvalidTokenError, parseBearer, PublicKeyUnavailableError } from '../auth/jwt-verifier.js';
import type { JwtVerifier, Role, TokenClaims } from '../auth/jwt-verifier.js';
import type { Backend, CallMeta } from '../grpc/backend.js';
import { ErrorCode, gqlError } from '../grpc/errors.js';
import type { Logger } from '../logger.js';
import { createLoaders } from './loaders.js';
import type { Loaders } from './loaders.js';

/** Contexto de cada request HTTP o de cada operación graphql-ws. */
export interface GqlContext {
  requestId: string;
  /** Usuario autenticado; `undefined` si no vino token (o si vino uno inválido). */
  user: TokenClaims | undefined;
  /** Error de autenticación si el token vino pero es inválido (o no se pudo validar). */
  authError: GraphQLError | undefined;
  /** Metadata para las llamadas gRPC (token crudo + x-request-id). */
  meta: CallMeta;
  loaders: Loaders;
  logger: Logger;
}

const REQUEST_ID_RE = /^[\w.:-]{1,128}$/;

function pickRequestId(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' && REQUEST_ID_RE.test(raw) ? raw : randomUUID();
}

export class ContextFactory {
  constructor(
    private readonly verifier: Pick<JwtVerifier, 'verify'>,
    private readonly backend: Backend,
    private readonly logger: Logger,
  ) {}

  /** Contexto de un request HTTP: `Authorization: Bearer <jwt>`. */
  fromHttp(headers: IncomingHttpHeaders): Promise<GqlContext> {
    return this.build(headers.authorization, pickRequestId(headers['x-request-id']));
  }

  /** Contexto de una operación graphql-ws: `connectionParams.authorization`. */
  fromWs(connectionParams: Readonly<Record<string, unknown>> | undefined): Promise<GqlContext> {
    const params = connectionParams ?? {};
    return this.build(
      params.authorization ?? params.Authorization,
      pickRequestId(params['x-request-id']),
    );
  }

  /** Valida el token de `connectionParams` al abrir el WebSocket (sin crear loaders). */
  async checkConnection(
    connectionParams: Readonly<Record<string, unknown>> | undefined,
  ): Promise<boolean> {
    const params = connectionParams ?? {};
    try {
      const token = parseBearer(params.authorization ?? params.Authorization);
      if (token) await this.verifier.verify(token);
      return true;
    } catch (err) {
      // Con users caído no se rechaza la conexión: cada operación informará UNAVAILABLE.
      return err instanceof PublicKeyUnavailableError;
    }
  }

  private async build(rawAuthorization: unknown, requestId: string): Promise<GqlContext> {
    let user: TokenClaims | undefined;
    let authError: GraphQLError | undefined;
    let token: string | undefined;
    try {
      token = parseBearer(rawAuthorization);
      if (token) user = await this.verifier.verify(token);
    } catch (err) {
      token = undefined;
      authError = toAuthError(err);
    }
    const meta: CallMeta = { token: user ? token : undefined, requestId };
    return {
      requestId,
      user,
      authError,
      meta,
      loaders: createLoaders(this.backend, meta),
      logger: this.logger.child({ requestId, userId: user?.sub }),
    };
  }
}

export function toAuthError(err: unknown): GraphQLError {
  if (err instanceof PublicKeyUnavailableError) {
    return gqlError(
      ErrorCode.UNAVAILABLE,
      'No se pudo validar la sesión: el servicio de usuarios no responde; reintenta más tarde.',
    );
  }
  const reason = err instanceof InvalidTokenError ? err.message : 'Token inválido';
  return gqlError(ErrorCode.UNAUTHENTICATED, `Sesión inválida: ${reason}.`);
}

/** Operaciones públicas: sin token está bien, pero si vino uno debe ser válido. */
export function optionalUser(ctx: GqlContext): TokenClaims | undefined {
  if (ctx.authError) throw ctx.authError;
  return ctx.user;
}

/** Operaciones autenticadas. */
export function requireUser(ctx: GqlContext): TokenClaims {
  if (ctx.authError) throw ctx.authError;
  if (!ctx.user) {
    throw gqlError(ErrorCode.UNAUTHENTICATED, 'Debes iniciar sesión para usar esta operación.');
  }
  return ctx.user;
}

export function requireRole(ctx: GqlContext, roles: readonly Role[]): TokenClaims {
  const user = requireUser(ctx);
  if (!roles.includes(user.role)) {
    throw gqlError(ErrorCode.FORBIDDEN, `Requiere rol ${roles.join(' o ')}.`);
  }
  return user;
}
