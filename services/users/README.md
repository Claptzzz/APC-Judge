# users — identidad y autenticación

|                     |                                                                                                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Paquete**         | `@juez/users`                                                                                                                                                           |
| **Responsabilidad** | Registro, login y perfiles. Hashea contraseñas, emite JWT RS256 y publica la llave pública para la verificación local. Dueño del rol (`CONTESTANT`, `SETTER`, `ADMIN`). |
| **Framework**       | Fastify (HTTP: `/health`, `/metrics`) + `@connectrpc/connect-node` en un servidor HTTP/2 aparte para gRPC.                                                              |
| **Puertos**         | HTTP **8081** · gRPC **50051**                                                                                                                                          |
| **BD**              | PostgreSQL, BD `users` (usuario `users_svc`).                                                                                                                           |

## RPCs que expone — `juez.users.v1.UserService`

| RPC            | Auth    | Notas                                                                                                            |
| -------------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| `Register`     | pública | Crea un usuario `CONTESTANT` y publica `user.registered`.                                                        |
| `Login`        | pública | Devuelve `access_token` (JWT RS256, claims `sub`, `username`, `role`, `iss`, `aud`, `iat`, `exp`; header `kid`). |
| `GetUser`      | JWT     |                                                                                                                  |
| `GetUsers`     | JWT     | Batch por ids; omite los inexistentes.                                                                           |
| `GetPublicKey` | pública | PEM + `kid` + `iss`/`aud` esperados.                                                                             |

## RPCs que consume

Ninguno.

## Eventos

|         | Topic             | Key       | Detalle                                                                                                                                               |
| ------- | ----------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Publica | `user.registered` | `user_id` | `UserRegistered`. Para no perder eventos si Kafka falla tras el `INSERT`, usar outbox o publicar con reintentos; documentar la decisión en la fase 1. |
| Consume | —                 |           |                                                                                                                                                       |

## Variables de entorno

| Variable                                                         | Ejemplo                                                                  |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `USERS_HTTP_PORT` · `USERS_GRPC_PORT`                            | `8081` · `50051`                                                         |
| `USERS_DATABASE_URL`                                             | `postgres://users_svc:users_svc_dev@localhost:5432/users`                |
| `KAFKA_BROKERS` · `USERS_KAFKA_CLIENT_ID`                        | `localhost:9092` · `users`                                               |
| `JWT_PRIVATE_KEY_PATH` · `JWT_PUBLIC_KEY_PATH`                   | `.secrets/jwt-private.pem` · `.secrets/jwt-public.pem` (`pnpm jwt:keys`) |
| `JWT_KEY_ID` · `JWT_ISSUER` · `JWT_AUDIENCE` · `JWT_TTL_SECONDS` | `dev-1` · `juez-users` · `juez` · `3600`                                 |
| `LOG_LEVEL`                                                      | `info`                                                                   |
