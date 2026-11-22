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
| `pnpm stack:up` / `stack:down` / `stack:logs`      | Infraestructura + servicios del backend (profile `apps`)     |
| `pnpm stack:seed` / `stack:smoke`                  | Seed de problems en el stack · prueba de humo del backend    |
| `pnpm jwt:keys`                                    | Par de llaves RS256 de desarrollo                            |
| `pnpm format` / `format:check`                     | Prettier                                                     |

Postgres se publica en el host en el puerto **55432** (no 5432, que suele ocupar un Postgres
del sistema); las `*_DATABASE_URL` de `.env.example` ya apuntan a `localhost:55432`. Para usar
otro puerto: `POSTGRES_PORT=55433` en tu `.env` y el mismo puerto en todas las
`*_DATABASE_URL`.

Para el asistente (BFF) hace falta Gemini: una API key de Google AI Studio
(`GEMINI_API_KEY`) o un proyecto de Vertex AI (`GOOGLE_GENAI_USE_VERTEXAI=true`,
`GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`). Ver la sección Gemini de `.env.example`.

## Backend completo en Docker

```sh
pnpm stack:up               # infra + users, problems, submissions, ranking, judge (x2) y mcp
pnpm stack:seed             # problemas de ejemplo (idempotente)
pnpm stack:smoke            # prueba de humo por gRPC: registro → submissions → veredictos → scoreboard
pnpm stack:logs judge       # logs (sin argumento, de todo el stack)
pnpm stack:down             # baja todo; los volúmenes se conservan
```

`stack:up` genera las llaves JWT si faltan, construye las imágenes `juez-<servicio>` y espera
a que todo quede healthy. Los servicios publican en el host los puertos de
[`docs/architecture.md`](docs/architecture.md#puertos); el judge no publica puertos. El admin
inicial es `USERS_ADMIN_USERNAME` / `USERS_ADMIN_PASSWORD` de `.env.example`. `pnpm infra:up`
levanta solo la infraestructura; `infra:down` e `infra:reset` bajan también los servicios.
