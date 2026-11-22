import { GraphQLError, GraphQLScalarType, Kind } from 'graphql';

// RFC 3339 con zona obligatoria (Z u offset); fracción de segundo opcional.
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;

function parseDateTime(value: unknown): Date {
  if (typeof value !== 'string' || !RFC3339.test(value)) {
    throw new GraphQLError(
      'DateTime inválido: se espera ISO 8601 / RFC 3339 con zona, p. ej. 2026-11-22T15:04:05Z',
    );
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new GraphQLError(`DateTime inválido: ${value}`);
  return date;
}

/** Entrada: string RFC 3339 con cualquier offset → Date. Salida: ISO UTC con milisegundos. */
export const DateTimeScalar = new GraphQLScalarType<Date, string>({
  name: 'DateTime',
  serialize(value) {
    const date = value instanceof Date ? value : new Date(value as string);
    if (Number.isNaN(date.getTime())) throw new GraphQLError('DateTime inválido en la respuesta');
    return date.toISOString();
  },
  parseValue: parseDateTime,
  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING) throw new GraphQLError('DateTime debe ser un string');
    return parseDateTime(ast.value);
  },
});
