# submissions — envíos de código

|                     |                                                                                                                                                                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Paquete**         | `@juez/submissions`                                                                                                                                                                                                                                         |
| **Responsabilidad** | Registrar submissions, exponer su estado y actualizarlo con el veredicto. Publica `submission.created` mediante el patrón **outbox** (misma transacción que el `INSERT`).                                                                                   |
| **Framework**       | NestJS como **app híbrida**: microservicio gRPC nativo (`Transport.GRPC`, `.proto` cargados en runtime con `@grpc/proto-loader`, tipos de `@juez/contracts/nest`), consumidor Kafka nativo (`Transport.KAFKA`, kafkajs) y HTTP para `/health` y `/metrics`. |
| **Puertos**         | HTTP **8083** · gRPC **50053**                                                                                                                                                                                                                              |
| **BD**              | PostgreSQL, BD `submissions` (usuario `submissions_svc`): tablas `submissions`, `outbox` y `processed_events` (dedupe por `event_id`).                                                                                                                      |

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
