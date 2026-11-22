# ranking — contests y scoreboard

|                     |                                                                                                                                                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Paquete**         | `@juez/ranking`                                                                                                                                                                                                                           |
| **Responsabilidad** | Gestión de contests y cálculo del scoreboard estilo ICPC (resueltos, penalización, intentos por problema) y de las estadísticas por usuario, a partir de los eventos.                                                                     |
| **Framework**       | Hono (HTTP: `/health`, `/ready`, `/metrics`, vía `@hono/node-server`) + `@connectrpc/connect-node` en un servidor HTTP/2 aparte para gRPC.                                                                                                |
| **Puertos**         | HTTP **8084** · gRPC **50054**                                                                                                                                                                                                            |
| **BD**              | PostgreSQL, BD `ranking` (usuario `ranking_svc`): **fuente de verdad** (contests, problemas del contest, usernames, submissions juzgadas y `processed_events`). Redis: **proyección** del scoreboard (sorted set + detalle por problema). |

## RPCs que expone — `juez.ranking.v1.RankingService`

| RPC             | Auth                 | Notas                                                                                                                                                                   |
| --------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CreateContest` | JWT `SETTER`/`ADMIN` | Valida `start < end`, 1–26 problemas sin repetir y cada `problem_id` con `problems.GetProblem` (timeout 3 s, token propagado).                                          |
| `GetContest`    | JWT                  | `status` (programado, en curso, terminado) se calcula con la hora actual. `problem_ids` en orden (A, B, C…).                                                            |
| `ListContests`  | JWT                  | Filtro opcional por `status` (calculado en SQL con la hora actual); paginado por cursor `(start_time desc, id desc)`. `page_size` por defecto 20, máximo 100.           |
| `GetScoreboard` | JWT                  | Lee de Redis; si la proyección del contest no existe la reconstruye desde Postgres. Sin username conocido muestra el `user_id`. `page_size` por defecto 50, máximo 200. |
| `GetUserStats`  | JWT                  | Desde Postgres: resueltos, intentados, total y conteo por veredicto (todas las submissions, con o sin contest). `user_id` vacío = el usuario del token.                 |

Errores de `CreateContest` al validar problemas (mapeo de la guía de la fase 1):

| Error de problems                                                                | Código devuelto |
| -------------------------------------------------------------------------------- | --------------- |
| `NotFound` (o respuesta sin problema)                                            | `NOT_FOUND`     |
| `Unavailable`, `DeadlineExceeded` o error de red (`ECONNREFUSED`, `ECONNRESET`…) | `UNAVAILABLE`   |
| Cualquier otro                                                                   | `INTERNAL`      |

Si en una misma llamada un problema no existe y otro no se pudo validar porque problems no
respondió, gana `UNAVAILABLE`: nunca se reporta "no existe" cuando el servicio no responde.

## RPCs que consume

| Servicio | RPC            | Para qué                                                                        |
| -------- | -------------- | ------------------------------------------------------------------------------- |
| users    | `GetPublicKey` | Verificar el JWT propagado (llave cacheada; recarga ante un `kid` desconocido). |
| problems | `GetProblem`   | Validar los `problem_ids` al crear un contest.                                  |

Ninguna se llama mientras se procesan eventos.

## Eventos

|         | Topic               | Detalle                                                                                                                                                          |
| ------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Consume | `user.registered`   | Group `RANKING_KAFKA_GROUP_ID`, `fromBeginning: true` (un ranking nuevo reconstruye los usernames re-consumiendo el log, ADR 0003). Guarda `user_id → username`. |
| Consume | `submission.judged` | Mismo group. Guarda la submission (estadísticas) y, si trae un `contest_id` existente, re-proyecta la fila del usuario en ese scoreboard.                        |
| Publica | —                   | Solo `<topic>.dlq`.                                                                                                                                              |

**Procesamiento de un evento** (`src/events/processor.ts`, `src/kafka/consumer.ts`):

1. Deserializar. Si falla → `<topic>.dlq` (`x-dlq-reason: deserialization_error`) y commit.
2. Validar (UUIDs, veredicto final, `submitted_at` presente). Si falla → DLQ (`invalid_event`).
3. **Una transacción de Postgres**: `INSERT INTO processed_events … ON CONFLICT DO NOTHING`;
   si ya existía es un duplicado y no se toca nada. Si no, se guarda el dato (`usernames` o
   `judged_submissions`).
4. Después del commit, se **recalcula desde Postgres la fila del usuario afectado** y se escribe
   en Redis en un `MULTI`. Esto también se hace ante un duplicado: si el proceso cayó entre el
   commit y Redis, la re-entrega repara la fila.
5. Commit manual del offset (`autoCommit: false`).

Errores en el paso 3: hasta 5 intentos con backoff (llamando a `heartbeat()`). Un error de datos
de Postgres (SQLSTATE clase 22/23) va a la DLQ (`processing_error`); uno transitorio (BD caída) se
relanza **sin commit** para que kafkajs vuelva a entregar el mensaje: nunca se pierde un evento
por una caída de la BD.

Un fallo de Redis en el paso 4 **nunca** reintenta el evento: se registra el error, `/ready`
pasa a `degraded` y la fila se corrige con el siguiente evento del mismo usuario, con la
reparación en segundo plano (reconstruye los contests afectados con backoff, tope 30 s) o con
`pnpm scoreboard:rebuild`.

Un `contest_id` que no existe: la submission se guarda igual (sirve para las estadísticas) y no se
actualiza ningún scoreboard.

## Modelo de datos (Postgres)

| Tabla                | Contenido                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `contests`           | `id`, `title`, `description`, `start_time`, `end_time` (`CHECK start < end`), `created_by`, `created_at`. Fechas `timestamp(3) with time zone` (cursores con precisión de ms). |
| `contest_problems`   | `(contest_id, position)` PK, `problem_id`, `letter` (A, B, C…). Únicos por `(contest_id, problem_id)` y `(contest_id, letter)`.                                                |
| `usernames`          | `user_id` → `username`.                                                                                                                                                        |
| `judged_submissions` | `submission_id` PK, `user_id`, `problem_id`, `contest_id` (sin FK), `verdict`, `submitted_at`, `judged_at`, `event_id`.                                                        |
| `processed_events`   | `event_id` PK, `topic`, `processed_at`.                                                                                                                                        |

Re-juzgamiento: si llega otro `event_id` para la misma `submission_id`, se actualiza el veredicto
solo si su `occurred_at` es igual o más reciente que el guardado.

## Reglas ICPC (`src/domain/icpc.ts`)

Por contest, usuario y problema:

- Solo cuentan las submissions del contest a sus problemas con `submitted_at` en
  **[start, end)**. Un usuario sin ninguna submission que cuente no aparece.
- El primer AC es el de **menor `submitted_at`** (no el primero en llegar); desempate por
  `submission_id`.
- Penalización = minutos enteros desde el inicio hasta el primer AC + 20 × rechazos con
  `submitted_at` **estrictamente anterior** a ese AC.
- `COMPILATION_ERROR` e `INTERNAL_ERROR` no cuentan como intento rechazado (ni en la
  penalización ni en `attempts`, así se cumple `penalty = solved_at_minute + 20 × (attempts − 1)`
  del contrato).
- Orden: más resueltos, luego menor penalización. Score en Redis = resueltos × 10⁷ −
  penalización. Empates de score comparten rank; dentro de un empate el orden es `user_id` desc
  (el de `ZREVRANGE`), igual en Redis y en el cálculo desde Postgres.
- `first_to_solve`: el usuario con el AC de menor `submitted_at` del problema dentro de la ventana.

## Proyección en Redis

Claves por contest (el hash tag `{id}` las deja en el mismo slot, `MULTI` sirve también en
Redis Cluster):

| Clave                     | Tipo       | Contenido                                             |
| ------------------------- | ---------- | ----------------------------------------------------- |
| `ranking:sb:{<id>}:score` | sorted set | `user_id` → resueltos × 10⁷ − penalización            |
| `ranking:sb:{<id>}:rows`  | hash       | `user_id` → JSON con el detalle por problema          |
| `ranking:sb:{<id>}:first` | hash       | `problem_id` → `user_id` del primer AC                |
| `ranking:sb:{<id>}:meta`  | hash       | `builtAt`, `updatedAt`; marca "proyección construida" |

Si un evento llega para un contest sin proyección (Redis vacío), se reconstruye el contest
completo en vez de escribir una sola fila. Si Redis no responde, `GetScoreboard` calcula la
página desde Postgres.

## Variables de entorno

| Variable                                                               | Ejemplo                                                          |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `RANKING_HTTP_PORT` · `RANKING_GRPC_PORT`                              | `8084` · `50054`                                                 |
| `RANKING_DATABASE_URL`                                                 | `postgres://ranking_svc:ranking_svc_dev@localhost:55432/ranking` |
| `RANKING_REDIS_URL`                                                    | `redis://localhost:6379/0`                                       |
| `KAFKA_BROKERS` · `RANKING_KAFKA_CLIENT_ID` · `RANKING_KAFKA_GROUP_ID` | `localhost:9092` · `ranking` · `ranking`                         |
| `USERS_GRPC_ADDR` · `PROBLEMS_GRPC_ADDR`                               | `localhost:50051` · `localhost:50052`                            |
| `JWT_ISSUER` · `JWT_AUDIENCE`                                          | `juez-users` · `juez`                                            |
| `LOG_LEVEL`                                                            | `info`                                                           |

Se validan con zod al arrancar (`src/config.ts`); si falta alguna obligatoria el proceso termina
con un log `fatal` que lista todas las inválidas.

## Scripts

| Script                                           | Qué hace                                                                                              |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `pnpm --filter @juez/ranking db:migrate`         | Aplica `migrations/` (SQL versionado, migrador de drizzle). Nunca editar una migración existente.     |
| `pnpm --filter @juez/ranking scoreboard:rebuild` | Regenera toda la proyección de Redis desde Postgres. Acepta `contest_id`s para reconstruir solo esos. |
| `pnpm --filter @juez/ranking start:dev`          | Arranca con `../../.env.example` y `../../.env`.                                                      |

En Docker: `node dist/migrate.js` y `node dist/scripts/rebuild.js`. En el docker-compose
(`pnpm stack:up`) las migraciones se aplican al arrancar el contenedor; el rebuild se corre con
`docker compose -p juez exec ranking node dist/scripts/rebuild.js`.

## Salud y resiliencia

- `GET /health`: proceso vivo.
- `GET /ready`:
  - **503** (`not_ready`) si Postgres no responde o si el consumidor no está unido al grupo o se
    cayó (eventos `GROUP_JOIN`, `CRASH`, `STOP`, `DISCONNECT` de kafkajs).
  - **200** `degraded` si Redis no responde, si la proyección tiene filas pendientes
    (`checks.projection.dirtyContests`) o si aún no se cargó la llave pública de users.
  - **200** `ready` si todo está bien.
- `GET /metrics`: Prometheus (`rpc_server_duration_seconds`, `kafka_events_processed_total`,
  `scoreboard_projection_writes_total` y las métricas por defecto de Node).
- Ninguna dependencia bloquea el arranque: Postgres se conecta en la primera consulta; Redis
  (ioredis, sin cola offline) y el consumidor Kafka reintentan en segundo plano con backoff
  exponencial (tope 30 s); la llave pública de users se pide en segundo plano con backoff y en
  cada RPC mientras falte (sin llave las RPC responden `UNAVAILABLE`, no `UNAUTHENTICATED`).
- `SIGTERM`/`SIGINT`: cierra los servidores gRPC y HTTP, detiene el consumidor (deja el grupo),
  la reparación y la carga de la llave, y cierra Redis y el pool de Postgres (límite 10 s).
- Logs JSON con pino (`service: ranking`); `x-request-id` se toma o genera por RPC, se devuelve en
  la respuesta y se propaga a problems.

## Tests

- `pnpm --filter @juez/ranking test`: unitarios con cobertura (≥ 60 %), sin infraestructura
  (repositorio y Redis en memoria, Kafka y problems simulados). Incluyen penalización con eventos
  desordenados, CE que no penaliza, submissions fuera de la ventana, eventos duplicados, fallo de
  Redis después del commit (degradado, sin reintento, corrección con el siguiente evento y con la
  reparación) y rebuild (igual a la proyección incremental).
- `pnpm --filter @juez/ranking test:int`: integración contra Postgres y Redis locales
  (`pnpm infra:up`); aplica las migraciones y prueba el repositorio real, el re-juzgamiento y el
  rebuild. Excluidos del CI.

## Desviaciones de la ficha

- **Postgres como fuente de verdad y Redis solo como proyección.** La ficha ponía en Redis el
  scoreboard, los resultados por problema, las estadísticas y la cache de usernames. Ahora:
  - Las submissions juzgadas, los usernames y `processed_events` viven en Postgres; cada evento se
    aplica en **una** transacción (dedupe + dato). La alternativa `SET processed:<event_id> NX`
    en Redis que mencionaba la ficha no se usa.
  - Redis guarda solo el scoreboard (sorted set + hash con el detalle por problema y el username
    del momento de la proyección), recalculado desde Postgres, así que es idempotente y se puede
    reconstruir (`scoreboard:rebuild`).
  - `GetUserStats` se calcula desde Postgres, no desde Redis.
- **`/ready` no exige Redis.** Si Redis cae, `/ready` responde 200 `degraded` en vez de 503:
  el servicio sigue procesando eventos (Postgres) y `GetScoreboard` calcula desde Postgres.
- **DLQ solo para errores que no se arreglan reintentando** (mensaje ilegible, datos inválidos,
  error de datos de Postgres tras 5 intentos). Los errores transitorios se re-entregan sin
  commit en vez de ir a la DLQ "tras N reintentos", para no perder eventos si la BD cae.
- **Máximo 26 problemas por contest** (una letra A–Z por problema).
- **`attempts` no cuenta CE ni IE**, para que se cumpla la fórmula del contrato
  `penalty_minutes = solved_at_minute + 20 × (attempts − 1)`.
- **`GetUserStats` con `user_id` vacío** devuelve las del usuario del token.

## Limitaciones conocidas

- El estado "degradado" de la proyección vive en memoria: si el proceso se reinicia antes de
  repararla, la fila queda desactualizada hasta el siguiente evento de ese usuario o un
  `scoreboard:rebuild`.
- Un rebuild que corre a la vez que una actualización incremental del mismo contest puede escribir
  una foto un poco más vieja (no hay control de versión en Redis); lo corrige el siguiente evento
  o un nuevo rebuild.
