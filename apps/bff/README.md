# bff — Backend for Frontend

|                     |                                                                                                                                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Paquete**         | `@juez/bff`                                                                                                                                                                                                                                                   |
| **Responsabilidad** | Única puerta de entrada del frontend. Expone GraphQL (queries, mutations y la subscription `submissionUpdated`), valida el JWT, orquesta llamadas gRPC a los servicios, empuja veredictos por WebSocket y aloja el asistente (Gemini + tools del MCP server). |
| **Framework**       | NestJS + `@nestjs/graphql` con Apollo; subscriptions con `graphql-ws`. Clientes gRPC con `@nestjs/microservices` (`@grpc/grpc-js`) cargando los `.proto` en runtime con `@grpc/proto-loader` y tipos de `@juez/contracts/nest`.                               |
| **Puertos**         | HTTP **4000** (`/graphql` HTTP + WS, `/health`, `/metrics`). Sin gRPC propio.                                                                                                                                                                                 |
| **BD**              | Ninguna.                                                                                                                                                                                                                                                      |

## Autenticación

- Recibe `Authorization: Bearer <jwt>` (HTTP) o `connectionParams.authorization` (WS).
- Verifica el JWT **localmente** (RS256, `iss`, `aud`, `exp`) con la llave pública obtenida de
  `UserService.GetPublicKey` al arrancar (cacheada; refrescar si llega un `kid` desconocido).
- Propaga el mismo token a cada servicio en la metadata gRPC `authorization` y al MCP server
  en el header HTTP `Authorization`.

## RPCs que expone

Ninguno gRPC. API GraphQL (esquema a definir en la fase 1), por ejemplo:
`register`, `login`, `me`, `problems`, `problem`, `createProblem`, `updateProblem`,
`createTestcaseUploadUrl`, `submit`, `submission`, `submissions`, `contests`, `contest`,
`createContest`, `scoreboard`, `userStats`, `askAssistant` y la subscription
`submissionUpdated(submissionId)`.

## RPCs que consume

| Servicio                              | RPCs                                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| users (`USERS_GRPC_ADDR`)             | `Register`, `Login`, `GetUser`, `GetUsers`, `GetPublicKey`                                |
| problems (`PROBLEMS_GRPC_ADDR`)       | `ListProblems`, `GetProblem`, `CreateProblem`, `UpdateProblem`, `CreateTestcaseUploadUrl` |
| submissions (`SUBMISSIONS_GRPC_ADDR`) | `CreateSubmission`, `GetSubmission`, `ListSubmissions`                                    |
| ranking (`RANKING_GRPC_ADDR`)         | `CreateContest`, `GetContest`, `ListContests`, `GetScoreboard`, `GetUserStats`            |
| mcp (`MCP_URL`)                       | MCP `tools/list` y `tools/call` (Streamable HTTP)                                         |
| Vertex AI                             | Gemini con function calling (las tools del MCP se declaran como funciones)                |

## Eventos

|         | Topic               | Detalle                                                                                                                                                                                                                                                   |
| ------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Consume | `submission.judged` | Consumer group propio (`BFF_KAFKA_GROUP_ID`). Publica el veredicto en la subscription `submissionUpdated` del cliente dueño de la submission. Con varias réplicas, cada una usa un group id único (prefijo + hostname) para recibir todos los veredictos. |
| Publica | —                   |                                                                                                                                                                                                                                                           |

## Variables de entorno

| Variable                                                                                                                           | Ejemplo                               |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `BFF_PORT`                                                                                                                         | `4000`                                |
| `BFF_CORS_ORIGIN`                                                                                                                  | `http://localhost:5173`               |
| `USERS_GRPC_ADDR` · `PROBLEMS_GRPC_ADDR` · `SUBMISSIONS_GRPC_ADDR` · `RANKING_GRPC_ADDR`                                           | `localhost:50051` … `localhost:50054` |
| `KAFKA_BROKERS`                                                                                                                    | `localhost:9092`                      |
| `BFF_KAFKA_CLIENT_ID` · `BFF_KAFKA_GROUP_ID`                                                                                       | `bff`                                 |
| `JWT_ISSUER` · `JWT_AUDIENCE`                                                                                                      | `juez-users` · `juez`                 |
| `MCP_URL`                                                                                                                          | `http://localhost:4100/mcp`           |
| `GOOGLE_GENAI_USE_VERTEXAI` · `GOOGLE_CLOUD_PROJECT` · `GOOGLE_CLOUD_LOCATION` · `GOOGLE_APPLICATION_CREDENTIALS` · `GEMINI_MODEL` | ver `.env.example`                    |
| `LOG_LEVEL`                                                                                                                        | `info`                                |
