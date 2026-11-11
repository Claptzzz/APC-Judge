# @juez/config

Configuración compartida del monorepo.

| Export                            | Contenido                                                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@juez/config/tsconfig.base.json` | TS estricto, `NodeNext`, ES2024, `types: ["node"]` (TS 6 ya no incluye `@types/*` por defecto).                                                  |
| `@juez/config/eslint`             | Flat config: `@eslint/js` + `typescript-eslint` recommended + `eslint-config-prettier`. Ignora `dist`, `coverage` y `src/gen`.                   |
| `@juez/config/vitest`             | `vitestPreset` y `defineJuezVitestConfig(overrides)`: coverage v8 con umbral **60 %** en lines/functions/branches/statements. Excluye `src/gen`. |

Cada paquete consumidor declara en sus `devDependencies`: `typescript`, `eslint`, `vitest`,
`@vitest/coverage-v8` y `@types/node` (son peers de este paquete).

```jsonc
// tsconfig.json
{
  "extends": "@juez/config/tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"],
}
```

Los paquetes NestJS agregan `experimentalDecorators` y `emitDecoratorMetadata` en su propio tsconfig.
