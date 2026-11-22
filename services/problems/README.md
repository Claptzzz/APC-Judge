# problems — catálogo de problemas y casos de prueba

|                     |                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Paquete**         | `@juez/problems`                                                                                                                                                                                  |
| **Responsabilidad** | CRUD de problemas (enunciado, tags, dificultad, límites, ejemplos, publicación) y gestión de casos de prueba en MinIO mediante URLs prefirmadas. Entrega al judge la especificación para evaluar. |
| **Framework**       | Express (HTTP: `/health`, `/ready`, `/metrics`) + `@connectrpc/connect-node` en un servidor HTTP/2 (h2c) aparte para gRPC. Kysely sobre Postgres; `@aws-sdk/client-s3` para MinIO.                |
| **Puertos**         | HTTP **8082** · gRPC **50052**                                                                                                                                                                    |
| **BD**              | PostgreSQL, BD `problems` (usuario `problems_svc`) + MinIO, bucket privado `testcases` (claves `problems/<problem_id>/<ordinal>.in` y `.out`).                                                    |

## RPCs que expone — `juez.problems.v1.ProblemService`

| RPC                       | Auth                       | Notas                                                                                                                                   |
| ------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `ListProblems`            | JWT opcional               | Filtros por `tags` (todos) y `difficulty`; paginación `page_size`/`page_token`. Anónimos y contestants solo ven publicados.             |
| `GetProblem`              | JWT opcional               | Por `id` o `slug` (oneof). Un problema sin publicar responde `NOT_FOUND` a quien no es `SETTER`/`ADMIN`.                                |
| `CreateProblem`           | JWT `SETTER`/`ADMIN`       | El autor sale del token. Slug único; si no viene, se genera desde el título (`A + B` → `a-mas-b`, colisiones → `-2`, `-3`…).            |
| `UpdateProblem`           | JWT `SETTER` autor/`ADMIN` | Actualización parcial (campos `optional`, `TagList`, `ExampleList`).                                                                    |
| `CreateTestcaseUploadUrl` | JWT `SETTER` autor/`ADMIN` | Devuelve URLs prefirmadas **PUT** para input y output del caso `ordinal`, firmadas con `S3_PUBLIC_ENDPOINT`.                            |
| `GetJudgeSpec`            | interna                    | Solo la usa el judge: límites + URLs prefirmadas **GET** de cada caso. Sin JWT de usuario; se restringe por red (NetworkPolicy en k8s). |

**JWT opcional:** las lecturas son públicas. Sin header `authorization` se atiende como anónimo
(solo publicados); si el header viene, el token debe ser válido o la RPC falla con
`UNAUTHENTICATED`. El claim `role` acepta `SETTER`, `ROLE_SETTER` o el número del enum.

**Casos de prueba.** `CreateTestcaseUploadUrl` registra el caso (o reutiliza el del mismo
`ordinal`) y el navegador sube directo a MinIO. Como problems no se entera de la subida,
cada caso pendiente se confirma de forma perezosa (HEAD de `.in` y `.out`) al leer el problema o
pedir el `GetJudgeSpec`. `testcase_count` cuenta solo los casos confirmados.

**`GetJudgeSpec`** devuelve los casos confirmados ordenados por `ordinal`, con URLs GET firmadas
con `S3_ENDPOINT` (el host interno de la red de servicios, el mismo que alcanza el judge) y una
vigencia de `S3_JUDGE_PRESIGN_TTL_SECONDS` (10 min). Errores: `NOT_FOUND` si el problema no
existe, `FAILED_PRECONDITION` si no tiene casos subidos y `UNAVAILABLE` si S3 no responde.

> La firma SigV4 incluye el host, así que cada URL se firma con el endpoint desde el que se va a
> usar: `S3_PUBLIC_ENDPOINT` para el navegador del setter y `S3_ENDPOINT` para el judge.

## RPCs que consume

| Servicio | RPC            | Para qué                                                                                                       |
| -------- | -------------- | -------------------------------------------------------------------------------------------------------------- |
| users    | `GetPublicKey` | Verificar localmente el JWT propagado (al arrancar, cacheado; se recarga ante un `kid` nuevo, máx. cada 30 s). |

Si users no está disponible al arrancar, el servicio arranca igual y pide la llave en la primera
RPC autenticada (`UNAVAILABLE` mientras no la obtenga). Las lecturas anónimas y `GetJudgeSpec`
no dependen de users.

## Eventos

Ni publica ni consume.

## Operación

| Script / endpoint | Qué hace                                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `pnpm db:migrate` | Aplica las migraciones de Kysely (`src/db/migrations`). Requiere `pnpm build`.                                             |
| `pnpm db:seed`    | Crea o actualiza 3 problemas publicados (`a-mas-b`, `suma-de-un-arreglo`, `suma-en-rangos`) y sube sus casos. Idempotente. |
| `pnpm start`      | Arranca el servicio (`dist/main.js`). Los scripts leen `../../.env` si existe.                                             |
| `GET /health`     | Vivo.                                                                                                                      |
| `GET /ready`      | 200 si responden Postgres (`select 1`) y el bucket (`HeadBucket`); 503 con el detalle si no.                               |
| `GET /metrics`    | Prometheus: métricas de proceso + `grpc_server_handled_total` y `grpc_server_handling_seconds`.                            |

`suma-en-rangos` tiene un caso con N = Q = 2·10^5 y rangos casi completos: la solución ingenua
O(N·Q) da TLE con el límite de 1 s. Los problemas sembrados tienen como autor el UUID fijo
`00000000-0000-4000-8000-000000000001` (no existe en users; un `ADMIN` puede editarlos).

Imagen: `docker build -f services/problems/Dockerfile -t juez-problems .` desde la raíz. La misma
imagen corre las migraciones y el seed: `node dist/scripts/migrate.js` / `node dist/scripts/seed.js`.
En el docker-compose (`pnpm stack:up`) las migraciones se aplican al arrancar el contenedor y el
seed se corre con `pnpm stack:seed`; ahí `S3_ENDPOINT` es `http://minio:9000` y
`S3_PUBLIC_ENDPOINT` es `http://localhost:9000`.

## Variables de entorno

| Variable                                          | Ejemplo                                                                                   |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `PROBLEMS_HTTP_PORT` · `PROBLEMS_GRPC_PORT`       | `8082` · `50052`                                                                          |
| `PROBLEMS_DATABASE_URL`                           | `postgres://problems_svc:problems_svc_dev@localhost:55432/problems`                       |
| `S3_ENDPOINT`                                     | `http://localhost:9000` (en docker `http://minio:9000`): operaciones y URLs GET del judge |
| `S3_PUBLIC_ENDPOINT`                              | `http://localhost:9000`: host con el que se firman las URLs PUT que usa el navegador      |
| `S3_REGION` · `S3_FORCE_PATH_STYLE`               | `us-east-1` · `true`                                                                      |
| `S3_ACCESS_KEY_ID` · `S3_SECRET_ACCESS_KEY`       | credenciales de desarrollo de MinIO                                                       |
| `S3_BUCKET_TESTCASES` · `S3_PRESIGN_TTL_SECONDS`  | `testcases` · `900` (vigencia de las URLs de subida)                                      |
| `S3_JUDGE_PRESIGN_TTL_SECONDS`                    | `600` (opcional; vigencia de las URLs GET de `GetJudgeSpec`, 60–3600)                     |
| `USERS_GRPC_ADDR` · `JWT_ISSUER` · `JWT_AUDIENCE` | `localhost:50051` · `juez-users` · `juez`                                                 |
| `LOG_LEVEL`                                       | `info`                                                                                    |
