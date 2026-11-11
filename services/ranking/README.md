# ranking — contests y scoreboard

|                     |                                                                                                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Paquete**         | `@juez/ranking`                                                                                                                                                                           |
| **Responsabilidad** | Gestión de contests y cálculo del scoreboard estilo ICPC (resueltos, penalización, intentos por problema) y de las estadísticas por usuario, a partir de los eventos.                     |
| **Framework**       | Hono (HTTP: `/health`, `/metrics`, vía `@hono/node-server`) + `@connectrpc/connect-node` en un servidor HTTP/2 aparte para gRPC.                                                          |
| **Puertos**         | HTTP **8084** · gRPC **50054**                                                                                                                                                            |
| **BD**              | PostgreSQL, BD `ranking` (usuario `ranking_svc`): contests y `processed_events`. Redis: scoreboard (sorted sets por contest), resultados por problema, estadísticas y cache de usernames. |

## RPCs que expone — `juez.ranking.v1.RankingService`

| RPC             | Auth                 | Notas                                                                                                                         |
| --------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `CreateContest` | JWT `SETTER`/`ADMIN` |                                                                                                                               |
| `GetContest`    | JWT                  | `status` se calcula con la hora actual.                                                                                       |
| `ListContests`  | JWT                  | Filtro opcional por `status`; paginado.                                                                                       |
| `GetScoreboard` | JWT                  | Orden: más resueltos, luego menor penalización. Penalización por problema = minuto del AC + 20 × intentos rechazados previos. |
| `GetUserStats`  | JWT                  | Resueltos, intentados, conteo por veredicto.                                                                                  |

## RPCs que consume

| Servicio | RPC            | Para qué                                       |
| -------- | -------------- | ---------------------------------------------- |
| users    | `GetPublicKey` | Verificar el JWT propagado.                    |
| problems | `GetProblem`   | Validar los `problem_ids` al crear un contest. |

## Eventos

|         | Topic               | Detalle                                                                                                             |
| ------- | ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Consume | `user.registered`   | Group `RANKING_KAFKA_GROUP_ID`. Guarda `user_id → username` para el scoreboard.                                     |
| Consume | `submission.judged` | Mismo group. Actualiza estadísticas y, si trae `contest_id` y `submitted_at` cae dentro del contest, el scoreboard. |
| Publica | —                   |                                                                                                                     |

**Idempotencia:** antes de aplicar un evento se registra su `event_id` (p. ej. `SET processed:<event_id> NX` en Redis, o `INSERT … ON CONFLICT DO NOTHING` en `processed_events`) y, si ya existía, se descarta. Tras N reintentos fallidos el mensaje va a `<topic>.dlq`.

## Variables de entorno

| Variable                                                               | Ejemplo                                                         |
| ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| `RANKING_HTTP_PORT` · `RANKING_GRPC_PORT`                              | `8084` · `50054`                                                |
| `RANKING_DATABASE_URL`                                                 | `postgres://ranking_svc:ranking_svc_dev@localhost:5432/ranking` |
| `RANKING_REDIS_URL`                                                    | `redis://localhost:6379/0`                                      |
| `KAFKA_BROKERS` · `RANKING_KAFKA_CLIENT_ID` · `RANKING_KAFKA_GROUP_ID` | `localhost:9092` · `ranking` · `ranking`                        |
| `USERS_GRPC_ADDR` · `PROBLEMS_GRPC_ADDR`                               | `localhost:50051` · `localhost:50052`                           |
| `JWT_ISSUER` · `JWT_AUDIENCE`                                          | `juez-users` · `juez`                                           |
| `LOG_LEVEL`                                                            | `info`                                                          |
