// Genera src/gen/graphql.ts (tipos TypeScript) desde el schema GraphQL del contrato
// (@juez/contracts/graphql). Se ejecuta antes de build y typecheck; el resultado no se
// commitea (src/gen/ está en .gitignore).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codegen } from '@graphql-codegen/core';
import * as typescriptPlugin from '@graphql-codegen/typescript';
import { GRAPHQL_SCHEMA_PATH } from '@juez/contracts/graphql';
import { parse } from 'graphql';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outFile = join(root, 'src', 'gen', 'graphql.ts');

const source = await readFile(GRAPHQL_SCHEMA_PATH, 'utf8');
const output = await codegen({
  filename: outFile,
  schema: parse(source),
  documents: [],
  plugins: [{ typescript: {} }],
  pluginMap: { typescript: typescriptPlugin },
  config: {
    // Enums como uniones de strings: el código generado solo aporta tipos (nada en runtime).
    enumsAsTypes: true,
    // DateTime entra como Date (lo parsea el escalar) y sale como string ISO 8601.
    scalars: { DateTime: { input: 'Date', output: 'string' } },
    avoidOptionals: { field: true, inputValue: false, object: true, defaultValue: false },
    maybeValue: 'T | null',
    inputMaybeValue: 'T | null | undefined',
    skipTypename: true,
    useTypeImports: true,
  },
});

await mkdir(dirname(outFile), { recursive: true });
await writeFile(
  outFile,
  `// Generado por scripts/codegen.mjs desde schema.graphql. NO EDITAR.\n/* eslint-disable */\n${output}`,
);
console.log(`tipos GraphQL generados en ${outFile}`);
