import { Catch } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { GqlContextType, GqlExceptionFilter } from '@nestjs/graphql';

/**
 * En GraphQL devuelve el error tal cual a Apollo / graphql-ws. Sin este filtro, el
 * manejador por defecto de Nest registra con nivel `error` cada GraphQLError esperado
 * (NOT_FOUND, UNAUTHENTICATED, ASSISTANT_DISABLED…). Los errores inesperados los registra
 * una sola vez `formatError` (app.module.ts), que además oculta su mensaje al cliente.
 * En HTTP (`/health`, `/ready`, `/metrics`) se comporta como el filtro por defecto.
 */
@Catch()
export class PassthroughGqlExceptionFilter
  extends BaseExceptionFilter
  implements GqlExceptionFilter
{
  override catch(exception: unknown, host: ArgumentsHost) {
    if (host.getType<GqlContextType>() === 'graphql') return exception;
    return super.catch(exception, host);
  }
}
