# juez-online

Juez online de programación competitiva construido con microservicios en TypeScript.
Taller de **Arquitectura de Software (UCN)**.

- Arquitectura: [`docs/architecture.md`](docs/architecture.md)
- Decisiones: [`docs/adr/`](docs/adr/)
- Guía para agentes y convenciones: [`CLAUDE.md`](CLAUDE.md)
- Ficha de cada componente: `apps/*/README.md` y `services/*/README.md`
- API GraphQL del frontend: [`packages/contracts/graphql/schema.graphql`](packages/contracts/graphql/schema.graphql)

## Requisitos

- **Node 26 LTS** (ver `.nvmrc`; con nvm: `nvm use`).
- **pnpm 12.18.0**, fijado en el campo `packageManager` del `package.json` raíz. No se usa
  corepack (Node 26 ya no lo incluye). Instálalo con npm:

  ```sh
  npm install -g pnpm@12.18.0 --allow-scripts=pnpm
  ```

  `--allow-scripts=pnpm` hace falta con npm ≥ 12, que bloquea los scripts de instalación de
  los paquetes globales; sin él no se instala el binario nativo de pnpm. Con cualquier pnpm
  reciente instalado, pnpm cambia solo a la versión de `packageManager`.

- **Docker** con Compose v2.
- `openssl` (para las llaves JWT de desarrollo).

## Primeros pasos

```sh
pnpm install
cp .env.example .env        # opcional: sin .env, infra usa .env.example
pnpm jwt:keys               # llaves RS256 de desarrollo en .secrets/
pnpm proto:gen              # genera el código de @juez/contracts
pnpm infra:up               # Kafka, Kafka UI, Postgres, Redis y MinIO (espera a healthy)
pnpm test
```

| Script                                             | Qué hace                                                     |
| -------------------------------------------------- | ------------------------------------------------------------ |
| `pnpm proto:lint` / `proto:breaking` / `proto:gen` | buf lint · buf breaking contra `main` · generación de código |
| `pnpm build` / `test` / `lint` / `typecheck`       | Tareas de turbo en todo el monorepo                          |
| `pnpm infra:up` / `infra:down` / `infra:reset`     | Infraestructura local (`infra/docker-compose.yml`)           |
| `pnpm jwt:keys`                                    | Par de llaves RS256 de desarrollo                            |
| `pnpm format` / `format:check`                     | Prettier                                                     |

Postgres se publica en el host en el puerto **55432** (no 5432, que suele ocupar un Postgres
del sistema); las `*_DATABASE_URL` de `.env.example` ya apuntan a `localhost:55432`. Para usar
otro puerto: `POSTGRES_PORT=55433` en tu `.env` y el mismo puerto en todas las
`*_DATABASE_URL`.

Para el asistente (BFF) hace falta Gemini: una API key de Google AI Studio
(`GEMINI_API_KEY`) o un proyecto de Vertex AI (`GOOGLE_GENAI_USE_VERTEXAI=true`,
`GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`). Ver la sección Gemini de `.env.example`.
