# CLAUDE.md — guía para agentes

Juez online de programación competitiva en microservicios TypeScript (taller de Arquitectura de
Software, UCN). Monorepo pnpm + turbo. Documentación, código y commits en **español**.

Antes de tocar algo, lee [`docs/architecture.md`](docs/architecture.md), los ADR de
[`docs/adr/`](docs/adr/), la ficha (`README.md`) del componente y los `.proto` que expone o
consume. La ficha y los contratos son la fuente de verdad. Las reglas completas de la fase 1
están en [`docs/agents/fase-1.md`](docs/agents/fase-1.md); cada fase puede traer su propia guía
en `docs/agents/`.

## Arquitectura en breve

- **web** (React + Vite + Apollo) → **bff** (NestJS + GraphQL, HTTP y `graphql-ws`) → servicios
  por **gRPC**. El bff es además cliente del **mcp** (MCP SDK v2, Streamable HTTP sin estado) y
  llama a Gemini con function calling.
- Servicios: **users** (Fastify + Connect, emite JWT RS256), **problems** (Express + Connect,
  Postgres + MinIO), **submissions** (NestJS híbrido, outbox), **ranking** (Hono + Connect,
  Postgres como fuente de verdad + proyección del scoreboard en Redis), **judge** (worker Node,
  sandbox con `prlimit` + `unshare -rn` + GNU time), **mcp** (tools de solo lectura).
- Eventos en Kafka con valor protobuf y key = id del agregado: `user.registered` (users, outbox;
  compactado), `submission.created` (submissions, outbox), `submission.judged` (judge). Cada topic
  tiene 3 particiones y su `<topic>.dlq`. Consumidores idempotentes por `event_id`.
- Contratos: `proto/` (buf v2) → `@juez/contracts` (protobuf-es para Connect, ts-proto para Nest;
  el código generado no se commitea). API del front: `packages/contracts/graphql/schema.graphql`.
- Una BD por servicio (en local, una instancia de Postgres con una BD y un usuario por servicio).
- El JWT del usuario viaja en la metadata gRPC `authorization: Bearer <jwt>` y cada servicio lo
  verifica con la llave de `UserService.GetPublicKey`.

## Reglas para agentes

- **Alcance:** modifica solo lo que tu tarea indica. Si necesitas un cambio fuera de alcance, no
  lo hagas: descríbelo en el reporte final ("Cambios propuestos fuera de alcance"). Si te desvías
  de la ficha, documéntalo en "Desviaciones de la ficha" del README del componente.
- **Git:** no hagas `commit`, `push` ni `merge`, no crees ramas y nunca agregues
  `Co-Authored-By`. Propón el mensaje de commit en el reporte.
- **Dependencias:** sin código nativo ni scripts de postinstall (si una es imprescindible,
  repórtala). Versiones exactas en `package.json`.
- **Implementación:** TypeScript estricto con `@juez/config` (tsconfig, ESLint, preset de
  Vitest). Configuración solo por variables de entorno validadas con zod al arrancar, con los
  nombres de `.env.example` y de la ficha. Logs JSON con pino y el nombre del servicio; propaga
  `x-request-id`. `/health` (vivo) y `/ready` (dependencias OK). Apagado ordenado con SIGTERM.
- **BD:** solo las credenciales de tu propia BD. Migraciones versionadas en el servicio con
  `db:migrate`; nunca modifiques una existente, crea una nueva. Columnas de fecha usadas en
  cursores: `timestamp(3) with time zone`.
- **Resiliencia:** el servicio arranca aunque Kafka, la BD u otros servicios no estén, y
  reintenta en segundo plano con backoff exponencial (tope 30 s). Readiness de consumidores
  Kafka con los eventos de kafkajs (`GROUP_JOIN`, `CRASH`, `STOP`, `DISCONNECT`). Commit manual
  del offset después de procesar, idempotencia por `event_id` y DLQ para lo que no se puede
  deserializar. Clientes gRPC con timeout (~3 s); `NotFound` → `NOT_FOUND`, `Unavailable` /
  `DeadlineExceeded` / error de red → `UNAVAILABLE` (nunca "no existe" si el servicio no
  responde). No llames por gRPC a otro servicio mientras procesas un evento, salvo que la ficha
  lo diga.
- **Tests y CI:** Vitest con cobertura ≥ 60 % solo con tests unitarios (el CI no levanta
  infraestructura; mockea gRPC, Kafka, BD y S3). `test:int` opcional contra la infra local,
  excluido del CI. Dockerfile multi-etapa con contexto en la raíz, `pnpm deploy --filter`,
  usuario no-root y `HEALTHCHECK`. Workflow por servicio que llama a `_service-ci.yml`.
- **macOS:** el judge depende de herramientas de Linux; sus tests se saltan con un mensaje claro
  fuera de Linux y el CI (Ubuntu) los ejecuta.
- **Formato:** Prettier (`pnpm format:check`) en todo lo que toques, incluido Markdown y YAML.
- **Reporte final:** qué hiciste, decisiones propias, desviaciones, cambios propuestos fuera de
  alcance, lo que no pudiste verificar y un mensaje de commit sugerido.

## Puertos

| Componente  | HTTP (host) | gRPC (host) | Dentro de la red de docker |
| ----------- | ----------- | ----------- | -------------------------- |
| web         | 5173        | —           | —                          |
| bff         | 4000        | —           | —                          |
| mcp         | 4100        | —           | `mcp:4100` (`/mcp`)        |
| users       | 8081        | 50051       | `users:50051`              |
| problems    | 8082        | 50052       | `problems:50052`           |
| submissions | 8083        | 50053       | `submissions:50053`        |
| ranking     | 8084        | 50054       | `ranking:50054`            |
| judge       | 8085 (\*)   | —           | `judge:8085` (2 réplicas)  |
| Postgres    | **55432**   | —           | `postgres:5432`            |
| Redis       | 6379        | —           | `redis:6379`               |
| Kafka       | 9092        | —           | `kafka:29092`              |
| Kafka UI    | 8080        | —           | —                          |
| MinIO       | 9000 / 9001 | —           | `minio:9000`               |

(\*) Solo cuando el judge corre fuera de docker; en el stack no publica puertos (2 réplicas).
Postgres usa 55432 en el host porque el 5432 suele estar ocupado por un Postgres del sistema.

## Comandos útiles

```sh
pnpm install
pnpm jwt:keys                 # llaves RS256 de desarrollo en .secrets/
pnpm proto:gen                # genera @juez/contracts (también lo hace el build)
pnpm build | test | lint | typecheck          # turbo en todo el monorepo
pnpm --filter @juez/<paquete> test            # un paquete
pnpm format:check             # prettier

# Infraestructura sola (Kafka, Kafka UI, Postgres, Redis, MinIO)
pnpm infra:up | infra:down | infra:reset      # reset borra los volúmenes

# Infra + backend en docker (profile `apps`; imágenes juez-<servicio>)
pnpm stack:up                 # build + up, espera a que todo esté healthy (/ready)
pnpm stack:seed               # seed de problems dentro del stack (idempotente)
pnpm stack:smoke              # prueba de humo por gRPC (buf curl); exit ≠ 0 si falla
pnpm stack:logs [servicio]    # logs en vivo
pnpm stack:down               # baja todo, conserva los volúmenes

pnpm proto:lint | proto:breaking               # buf
```

Notas del stack:

- `infra/scripts/compose.sh` usa `.env` (o `.env.example`). `JUEZ_ENV_FILE=<archivo>` y
  `COMPOSE_PROJECT_NAME=<nombre>` permiten levantar un segundo stack (p. ej. desde otro worktree)
  con otros puertos sin chocar con el proyecto `juez`.
- Las migraciones de cada servicio corren al arrancar su contenedor; el judge usa el perfil
  seccomp de [`infra/judge/`](infra/judge/README.md) para que `unshare -rn` funcione.
- `docker compose -p juez exec <servicio> …` para entrar a un contenedor (p. ej.
  `exec ranking node dist/scripts/rebuild.js`).
