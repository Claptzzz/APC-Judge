# users — identidad y autenticación

|                     |                                                                                                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Paquete**         | `@juez/users`                                                                                                                                                           |
| **Responsabilidad** | Registro, login y perfiles. Hashea contraseñas, emite JWT RS256 y publica la llave pública para la verificación local. Dueño del rol (`CONTESTANT`, `SETTER`, `ADMIN`). |
| **Framework**       | Fastify (HTTP: `/health`, `/ready`, `/metrics`) + `@connectrpc/connect-node` en un servidor HTTP/2 aparte para gRPC. Drizzle ORM sobre `postgres` (postgres.js).        |
| **Puertos**         | HTTP **8081** · gRPC **50051**                                                                                                                                          |
| **BD**              | PostgreSQL, BD `users` (usuario `users_svc`).                                                                                                                           |

## RPCs que expone — `juez.users.v1.UserService`

| RPC            | Auth    | Notas                                                                                                                                         |
| -------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `Register`     | pública | Crea un usuario `CONTESTANT` y, en la misma transacción, la fila del outbox con `user.registered`.                                            |
| `Login`        | pública | Acepta username o email (sin distinguir mayúsculas). Devuelve `access_token` (JWT RS256), `token_type = "Bearer"`, `expires_at` y el usuario. |
| `GetUser`      | JWT     | `email` vacío salvo para el propio usuario o un `ADMIN`.                                                                                      |
| `GetUsers`     | JWT     | Batch por ids (máx. 1000), en el orden pedido, sin duplicados; omite inexistentes e ids que no son UUID. Misma regla de `email`.              |
| `GetPublicKey` | pública | PEM (SPKI) + `kid` + `algorithm = "RS256"` + `iss`/`aud` esperados.                                                                           |

### Errores (códigos Connect/gRPC)

| Caso                                                                | Código             |
| ------------------------------------------------------------------- | ------------------ |
| Datos inválidos (username, email, password, id no UUID, > 1000 ids) | `invalid_argument` |
| Username (sin distinguir mayúsculas) o email ya registrados         | `already_exists`   |
| Credenciales incorrectas (mismo mensaje si el usuario no existe)    | `unauthenticated`  |
| Falta `authorization`, no es `Bearer`, o el JWT es inválido/expiró  | `unauthenticated`  |
| `GetUser` de un id inexistente                                      | `not_found`        |
| Error inesperado (el detalle solo va al log)                        | `internal`         |

Reglas de registro: `username` de 3 a 32 caracteres `[A-Za-z0-9_-]`; `email` válido (se guarda en
minúsculas); `password` de 8 a 128 caracteres.

### JWT

Header `{ alg: "RS256", typ: "JWT", kid: JWT_KEY_ID }`. Claims: `sub` (id del usuario), `username`,
`role` **como nombre** (`"CONTESTANT"`, `"SETTER"` o `"ADMIN"`), `iss`, `aud`, `iat` y
`exp = iat + JWT_TTL_SECONDS` (1 h). Los demás servicios verifican firma, `iss`, `aud` y `exp`
con la llave de `GetPublicKey`.

### Contraseñas

scrypt de `node:crypto` (N = 2^15, r = 8, p = 1, salt aleatorio de 16 bytes, clave de 64 bytes),
guardado como `scrypt$N$r$p$<salt b64>$<hash b64>`: los parámetros viajan con el hash y se pueden
subir sin invalidar los existentes. La comparación usa `timingSafeEqual`, y un login con un usuario
inexistente verifica contra un hash fijo para que no se pueda enumerar usuarios por tiempo de
respuesta.

## RPCs que consume

Ninguno.

## Eventos

|         | Topic             | Key       | Detalle                                                             |
| ------- | ----------------- | --------- | ------------------------------------------------------------------- |
| Publica | `user.registered` | `user_id` | `UserRegistered` vía **outbox** (ver abajo). Entrega at-least-once. |
| Consume | —                 |           |                                                                     |

**Outbox** (decisión de la fase 1, ver [ADR 0004](../../docs/adr/0004-outbox-consumidores-idempotentes.md)):
`Register` inserta el usuario y una fila en `outbox` (protobuf de `encodeEvent`, key, headers) en la
misma transacción. Un relay en el mismo proceso hace polling cada `USERS_OUTBOX_POLL_INTERVAL_MS`:
toma hasta `USERS_OUTBOX_BATCH_SIZE` filas pendientes con `FOR UPDATE SKIP LOCKED`, las publica con
un productor kafkajs idempotente (`acks = -1`) y marca `published_at` antes del `COMMIT`. Si Kafka
falla, la transacción se revierte y reintenta con backoff exponencial (tope 30 s). Varias réplicas
pueden correr el relay a la vez sin publicar la misma fila en paralelo.

## Variables de entorno

Validadas con zod al arrancar; si alguna es inválida, el proceso termina con un log `fatal` que las
lista todas.

| Variable                                                              | Ejemplo / por defecto                                                                                                    |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `USERS_HTTP_PORT` · `USERS_GRPC_PORT`                                 | `8081` · `50051`                                                                                                         |
| `USERS_DATABASE_URL`                                                  | `postgres://users_svc:users_svc_dev@localhost:5432/users` (obligatoria)                                                  |
| `KAFKA_BROKERS` · `USERS_KAFKA_CLIENT_ID`                             | `localhost:9092` (obligatoria, separadas por coma) · `users`                                                             |
| `USERS_OUTBOX_POLL_INTERVAL_MS` · `USERS_OUTBOX_BATCH_SIZE`           | `500` · `100` (**nuevas**, opcionales)                                                                                   |
| `JWT_PRIVATE_KEY_PATH` · `JWT_PUBLIC_KEY_PATH`                        | `.secrets/jwt-private.pem` (obligatoria) · `.secrets/jwt-public.pem` (opcional: si está, debe corresponder a la privada) |
| `JWT_KEY_ID` · `JWT_ISSUER` · `JWT_AUDIENCE` · `JWT_TTL_SECONDS`      | `dev-1` · `juez-users` · `juez` · `3600`                                                                                 |
| `USERS_ADMIN_USERNAME` · `USERS_ADMIN_EMAIL` · `USERS_ADMIN_PASSWORD` | (**nuevas**, opcionales; las tres o ninguna) admin inicial                                                               |
| `LOG_LEVEL` · `NODE_ENV`                                              | `info` · `development`                                                                                                   |

Las rutas relativas de las llaves se buscan desde el directorio actual y, si no existen ahí, desde la
raíz del workspace, así `.secrets/…` funciona al correr desde la raíz o desde `services/users`.

**Admin inicial:** si `USERS_ADMIN_*` están definidas, al arrancar se crea ese usuario con rol
`ADMIN` (y su `user.registered`). Es idempotente: si el username o el email ya existen no cambia
nada, ni siquiera el rol ni la contraseña.

## Operación

| Endpoint (HTTP 8081) | Descripción                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /health`        | Proceso vivo.                                                                                                                                                      |
| `GET /ready`         | `200` si Postgres responde, `503` si no. Kafka y el relay se informan en `checks` pero **no** bloquean: con el outbox, users sigue registrando aunque Kafka caiga. |
| `GET /metrics`       | Prometheus: métricas del proceso, `rpc_server_duration_seconds{method,code}` y `outbox_published_total`.                                                           |

- **Logs:** JSON (pino) con `service: "users"`; una línea por RPC con `rpc`, `code`, `durationMs` y
  `requestId`. Se redactan `password`, `passwordHash` y `authorization`.
- **`x-request-id`:** se toma de la metadata entrante (o se genera), va en cada log de la RPC y se
  devuelve en la respuesta y en los errores. users no llama a otros servicios.
- **Apagado (SIGTERM/SIGINT):** cierra los servidores gRPC y HTTP, detiene el relay después de la
  pasada en curso, desconecta Kafka y cierra el pool de Postgres (tope de 10 s).

```sh
pnpm --filter @juez/users build
pnpm --filter @juez/users db:migrate     # aplica migrations/ (drizzle migrator)
pnpm --filter @juez/users start:dev      # lee ../../.env.example y ../../.env
pnpm --filter @juez/users test           # unitarios + coverage (CI)
pnpm --filter @juez/users test:int       # integración: requiere pnpm infra:up y pnpm jwt:keys
```

Las variables del shell tienen prioridad sobre los archivos `.env`
(p. ej. `USERS_DATABASE_URL=…:5433/users pnpm --filter @juez/users start:dev`).

**Migraciones:** SQL versionado en `migrations/` con el journal de drizzle (`meta/_journal.json`),
aplicado con el migrador de `drizzle-orm`. Se escriben a mano y deben mantenerse en sync con
`src/db/schema.ts`: `drizzle-kit` no se usa porque depende de `esbuild`, que requiere un postinstall.

**Docker:** `docker build -f services/users/Dockerfile -t juez-users .` (contexto en la raíz). Las
llaves se montan como archivos (`JWT_PRIVATE_KEY_PATH=/run/secrets/jwt-private.pem`). Las
migraciones se aplican con `docker run --rm <imagen> node dist/migrate.js`.
