# juez-online

Juez online de programación competitiva construido con microservicios en TypeScript.
Taller de **Arquitectura de Software (UCN)**.

- Arquitectura: [`docs/architecture.md`](docs/architecture.md)
- Decisiones: [`docs/adr/`](docs/adr/)
- Guía para agentes y convenciones: [`CLAUDE.md`](CLAUDE.md)
- Ficha de cada componente: `apps/*/README.md` y `services/*/README.md`

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

Si el puerto 5432 ya está ocupado en tu máquina: `POSTGRES_PORT=5433 pnpm infra:up`
(y ajusta `*_DATABASE_URL` en tu `.env`).
