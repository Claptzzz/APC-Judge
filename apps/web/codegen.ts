import type { CodegenConfig } from '@graphql-codegen/cli';

// Tipos del cliente generados desde el contrato del BFF (lo único que el front toma del
// monorepo). Las operaciones se escriben con `graphql()` de `src/gen` en `src/graphql/`.
const config: CodegenConfig = {
  schema: '../../packages/contracts/graphql/schema.graphql',
  documents: ['src/**/*.{ts,tsx}', '!src/gen/**'],
  ignoreNoDocuments: false,
  generates: {
    './src/gen/': {
      preset: 'client',
      presetConfig: { fragmentMasking: false },
      config: {
        useTypeImports: true,
        enumsAsTypes: true,
        strictScalars: true,
        scalars: { DateTime: 'string' },
        skipTypename: false,
      },
    },
  },
  hooks: {},
};

export default config;
