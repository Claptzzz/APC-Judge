# problems — catálogo de problemas y casos de prueba

|                     |                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Paquete**         | `@juez/problems`                                                                                                                                                                                  |
| **Responsabilidad** | CRUD de problemas (enunciado, tags, dificultad, límites, ejemplos, publicación) y gestión de casos de prueba en MinIO mediante URLs prefirmadas. Entrega al judge la especificación para evaluar. |
| **Framework**       | Express (HTTP: `/health`, `/metrics`) + `@connectrpc/connect-node` en un servidor HTTP/2 aparte para gRPC.                                                                                        |
| **Puertos**         | HTTP **8082** · gRPC **50052**                                                                                                                                                                    |
| **BD**              | PostgreSQL, BD `problems` (usuario `problems_svc`) + MinIO, bucket privado `testcases` (claves sugeridas `<problem_id>/<ordinal>.in` y `.out`).                                                   |

## RPCs que expone — `juez.problems.v1.ProblemService`

| RPC                       | Auth                 | Notas                                                                                                                                   |
| ------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `ListProblems`            | JWT                  | Filtros por `tags` (todos) y `difficulty`; paginación `page_size`/`page_token`. Contestants solo ven publicados.                        |
| `GetProblem`              | JWT                  | Por `id` o `slug` (oneof).                                                                                                              |
| `CreateProblem`           | JWT `SETTER`/`ADMIN` | El autor sale del token.                                                                                                                |
| `UpdateProblem`           | JWT autor/`ADMIN`    | Actualización parcial (campos `optional`, `TagList`, `ExampleList`).                                                                    |
| `CreateTestcaseUploadUrl` | JWT autor/`ADMIN`    | Devuelve URLs prefirmadas **PUT** para input y output del caso `ordinal`.                                                               |
| `GetJudgeSpec`            | interna              | Solo la usa el judge: límites + URLs prefirmadas **GET** de cada caso. Sin JWT de usuario; se restringe por red (NetworkPolicy en k8s). |

## RPCs que consume

| Servicio | RPC            | Para qué                                                       |
| -------- | -------------- | -------------------------------------------------------------- |
| users    | `GetPublicKey` | Verificar localmente el JWT propagado (al arrancar, cacheado). |

## Eventos

Ni publica ni consume.

## Variables de entorno

| Variable                                          | Ejemplo                                                                       |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| `PROBLEMS_HTTP_PORT` · `PROBLEMS_GRPC_PORT`       | `8082` · `50052`                                                              |
| `PROBLEMS_DATABASE_URL`                           | `postgres://problems_svc:problems_svc_dev@localhost:5432/problems`            |
| `S3_ENDPOINT` · `S3_PUBLIC_ENDPOINT`              | `http://localhost:9000` (el público es el host con el que se firman las URLs) |
| `S3_REGION` · `S3_FORCE_PATH_STYLE`               | `us-east-1` · `true`                                                          |
| `S3_ACCESS_KEY_ID` · `S3_SECRET_ACCESS_KEY`       | credenciales de desarrollo de MinIO                                           |
| `S3_BUCKET_TESTCASES` · `S3_PRESIGN_TTL_SECONDS`  | `testcases` · `900`                                                           |
| `USERS_GRPC_ADDR` · `JWT_ISSUER` · `JWT_AUDIENCE` | `localhost:50051` · `juez-users` · `juez`                                     |
| `LOG_LEVEL`                                       | `info`                                                                        |
