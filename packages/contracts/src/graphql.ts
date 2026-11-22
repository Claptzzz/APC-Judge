// Ubicación del schema GraphQL (schema-first) que implementa el BFF y consume el frontend.
//   import { GRAPHQL_SCHEMA_PATH } from '@juez/contracts/graphql';
//   GraphQLModule.forRoot({ typePaths: [GRAPHQL_SCHEMA_PATH], ... })
// Para generar tipos (p. ej. GraphQL Code Generator) se usa la misma ruta o el archivo
// `packages/contracts/graphql/schema.graphql`.
import { fileURLToPath } from 'node:url';

/** Ruta absoluta de `graphql/schema.graphql` dentro del paquete. */
export const GRAPHQL_SCHEMA_PATH = fileURLToPath(
  new URL('../graphql/schema.graphql', import.meta.url),
);
