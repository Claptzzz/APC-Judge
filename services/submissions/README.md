# submissions — envíos de código

|                     |                                                                                                                                                                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Paquete**         | `@juez/submissions`                                                                                                                                                                                                                                                                                     |
| **Responsabilidad** | Registrar submissions, exponer su estado y actualizarlo con el veredicto. Publica `submission.created` mediante el patrón **outbox** (misma transacción que el `INSERT`).                                                                                                                               |
| **Framework**       | NestJS como **app híbrida**: microservicio gRPC nativo (`Transport.GRPC`, `.proto` cargados en runtime con `@grpc/proto-loader`, tipos de `@juez/contracts/nest`), consumidor Kafka con kafkajs directo (ver [Desviaciones de la ficha](#desviaciones-de-la-ficha)) y HTTP para `/health` y `/metrics`. |
| **Puertos**         | HTTP **8083** · gRPC **50053**                                                                                                                                                                                                                                                                          |
| **BD**              | PostgreSQL, BD `submissions` (usuario `submissions_svc`): tablas `submissions`, `outbox` y `processed_events` (dedupe por `event_id`).                                                                                                                                                                  |

## RPCs que expone — `juez.submissions.v1.SubmissionService`

| RPC                | Auth | Notas                                                                                                     |
| ------------------ | ---- | --------------------------------------------------------------------------------------------------------- |
| `CreateSubmission` | JWT  | `user_id` sale del token (`sub`). Inserta la submission `PENDING` + fila outbox en una transacción.       |
| `GetSubmission`    | JWT  | El dueño o `ADMIN` ven `source_code`.                                                                     |
| `ListSubmissions`  | JWT  | Filtros opcionales `user_id`, `problem_id`, `contest_id`; orden `submitted_at` desc; `source_code` vacío. |

## RPCs que consume

| Servicio | RPC            | Para qué                                                                           |
| -------- | -------------- | ---------------------------------------------------------------------------------- |
| users    | `GetPublicKey` | Verificar el JWT propagado.                                                        |
| problems | `GetProblem`   | Validar que el problema existe y está publicado.                                   |
| ranking  | `GetContest`   | Si viene `contest_id`: validar que el contest está en curso e incluye el problema. |

Las llamadas a problems y ranking tienen un timeout de **3 s** por llamada. Mapeo de errores
hacia el cliente de `CreateSubmission`:

| Error del servicio dependiente                                                   | Código devuelto                              |
| -------------------------------------------------------------------------------- | -------------------------------------------- |
| `NotFound` (o respuesta sin el recurso)                                          | `NOT_FOUND`                                  |
| `Unavailable`, `DeadlineExceeded` o error de red (`ECONNREFUSED`, `ECONNRESET`…) | `UNAVAILABLE` (“El servicio X no responde…”) |
| Cualquier otro                                                                   | `INTERNAL`                                   |

## Eventos

|         | Topic                | Key             | Detalle                                                                                                                                                  |
| ------- | -------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Publica | `submission.created` | `submission_id` | Relay del outbox: lee filas pendientes (`FOR UPDATE SKIP LOCKED`), publica y las marca como enviadas. Entrega _at-least-once_.                           |
| Consume | `submission.judged`  |                 | Group `SUBMISSIONS_KAFKA_GROUP_ID`. Actualiza veredicto, tiempos y casos; idempotente por `event_id`. Tras N reintentos envía a `submission.judged.dlq`. |

## Variables de entorno

| Variable                                                                | Ejemplo                                                                     |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `SUBMISSIONS_HTTP_PORT` · `SUBMISSIONS_GRPC_PORT`                       | `8083` · `50053`                                                            |
| `SUBMISSIONS_DATABASE_URL`                                              | `postgres://submissions_svc:submissions_svc_dev@localhost:5432/submissions` |
| `KAFKA_BROKERS`                                                         | `localhost:9092`                                                            |
| `SUBMISSIONS_KAFKA_CLIENT_ID` · `SUBMISSIONS_KAFKA_GROUP_ID`            | `submissions`                                                               |
| `SUBMISSIONS_OUTBOX_POLL_INTERVAL_MS` · `SUBMISSIONS_OUTBOX_BATCH_SIZE` | `500` · `100`                                                               |
| `USERS_GRPC_ADDR` · `PROBLEMS_GRPC_ADDR` · `RANKING_GRPC_ADDR`          | `localhost:50051` · `:50052` · `:50054`                                     |
| `JWT_ISSUER` · `JWT_AUDIENCE`                                           | `juez-users` · `juez`                                                       |
| `LOG_LEVEL`                                                             | `info`                                                                      |

## Salud y resiliencia

- `GET /health`: proceso vivo.
- `GET /ready`: **503** si la BD no responde o si el consumidor de `submission.judged` no está
  unido al grupo o se cayó. El estado del consumidor se lleva con los eventos instrumentados de
  kafkajs (`GROUP_JOIN`, `CRASH`, `STOP`, `DISCONNECT`), igual que `KafkaReadiness` del judge.
- Si Kafka no está disponible al arrancar, el servicio arranca igual y el consumidor reintenta en
  segundo plano con backoff exponencial (1 s, 2 s, 4 s… tope 30 s) hasta conectar. Si kafkajs
  decide no reiniciar tras un crash (error no reintentable), el consumidor se vuelve a arrancar
  con el mismo backoff.
- El relay del outbox reintenta con backoff (tope 30 s) y reconecta el productor en cada intento.
- La llave pública de users (`GetPublicKey`, timeout 3 s) se pide al arrancar sin bloquearlo; si
  users no responde se reintenta en segundo plano con backoff (tope 30 s) y en cada RPC. Mientras
  no haya llave, las RPC responden `UNAVAILABLE`; `UNAUTHENTICATED` queda solo para tokens
  ausentes o inválidos.

## Paginación

`ListSubmissions` usa un cursor `(submitted_at, id)` serializado con `Date#toISOString`, que
tiene precisión de milisegundos. Por eso `submitted_at` es `timestamp(3) with time zone`
(migración `0001_submitted_at_ms_precision`): con la precisión por defecto (microsegundos), dos
submissions dentro del mismo milisegundo quedaban indistinguibles en el cursor y una se perdía
entre páginas.

## Tests

- `pnpm --filter @juez/submissions test`: unitarios con cobertura (≥ 60%), sin infraestructura.
- `pnpm --filter @juez/submissions test:int`: integración contra el Postgres local
  (`pnpm infra:up`); aplica las migraciones y verifica la paginación con empates de milisegundo.
  Excluidos del CI.

## Desviaciones de la ficha

- **Consumidor de `submission.judged` con kafkajs directo en vez de `Transport.KAFKA`.** La
  ficha indicaba el transporte Kafka nativo de NestJS (`@EventPattern`). Se usa un `Consumer`
  de kafkajs instanciado a mano (`src/kafka/judged.consumer.ts`) porque necesitamos:
  - **Commit manual del offset** (`autoCommit: false` + `commitOffsets` explícito) _después_ de
    persistir el veredicto en la misma transacción que el dedupe por `event_id`. Con
    `Transport.KAFKA` el commit lo gestiona el `ServerKafka` de Nest y no hay un punto fiable para
    commitear solo tras un procesamiento exitoso ni para dejar el offset sin commitear ante un
    error de BD y que kafkajs reintente.
  - **DLQ propia**: los mensajes que no se pueden deserializar (o con veredicto desconocido) se
    reenvían a `submission.judged.dlq` con cabeceras de diagnóstico (`x-dlq-reason`,
    `x-original-topic/partition/offset`) y luego se commitea su offset. `Transport.KAFKA`
    deserializa antes de llegar al handler (y espera JSON, no Protobuf), así que un mensaje
    corrupto falla dentro del framework sin acceso al mensaje original para mandarlo a la DLQ.
  - **Readiness y reintentos de arranque**: acceso directo a los eventos instrumentados del
    consumidor (`GROUP_JOIN`, `CRASH`, `STOP`, `DISCONNECT`) para `/ready`, y control del
    arranque para reintentar en segundo plano sin bloquear el bootstrap de Nest
    (`startAllMicroservices` esperaría a que Kafka conecte).

  gRPC sigue usando `Transport.GRPC` nativo como indica la ficha.
