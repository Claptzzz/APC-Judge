# bff — Backend for Frontend

|                     |                                                                                                                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Paquete**         | `@juez/bff`                                                                                                                                                                                                                                                                           |
| **Responsabilidad** | Única puerta de entrada del frontend. Expone GraphQL (queries, mutations y las subscriptions `submissionUpdated` y `scoreboardUpdated`), valida el JWT, orquesta llamadas gRPC a los servicios, empuja veredictos por WebSocket y aloja el asistente (Gemini + tools del MCP server). |
| **Framework**       | NestJS + `@nestjs/graphql` con Apollo; subscriptions con `graphql-ws`. Clientes gRPC con `@nestjs/microservices` (`@grpc/grpc-js`) cargando los `.proto` en runtime con `@grpc/proto-loader` y tipos de `@juez/contracts/nest`.                                                       |
| **Puertos**         | HTTP **4000** (`/graphql` HTTP + WS, `/health`, `/metrics`). Sin gRPC propio.                                                                                                                                                                                                         |
| **BD**              | Ninguna.                                                                                                                                                                                                                                                                              |

## Autenticación

- Recibe `Authorization: Bearer <jwt>` (HTTP) o `connectionParams.authorization` (WS).
- Verifica el JWT **localmente** (RS256, `iss`, `aud`, `exp`) con la llave pública obtenida de
  `UserService.GetPublicKey` al arrancar (cacheada; refrescar si llega un `kid` desconocido).
- Propaga el mismo token a cada servicio en la metadata gRPC `authorization` y al MCP server
  en el header HTTP `Authorization`.

## RPCs que expone

Ninguno gRPC. API GraphQL **schema-first**: el contrato es
[`packages/contracts/graphql/schema.graphql`](../../packages/contracts/graphql/schema.graphql),
que se carga con `GRAPHQL_SCHEMA_PATH` de `@juez/contracts/graphql`
(`typePaths: [GRAPHQL_SCHEMA_PATH]`). Las descripciones del schema indican quién puede usar
cada operación, los códigos de error (`extensions.code`) y la paginación.

| Tipo         | Operaciones                                                                                                                 |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Query        | `me`, `user`, `problems`, `problem`, `submission`, `submissions`, `contest`, `contests`, `scoreboard`, `userStats`          |
| Mutation     | `register`, `login`, `createProblem`, `updateProblem`, `createTestcaseUploadUrl`, `submit`, `createContest`, `askAssistant` |
| Subscription | `submissionUpdated(id)`, `scoreboardUpdated(contestId)`                                                                     |

Notas para la implementación:

- `register` devuelve token: el BFF llama a `Register` y luego a `Login` con las mismas
  credenciales.
- Enums: los del proto sin el prefijo ni `UNSPECIFIED` (`VERDICT_ACCEPTED` → `ACCEPTED`); un
  filtro `null` se envía como `*_UNSPECIFIED`. Fechas: `Timestamp` → ISO 8601 en UTC.
- Campos que el proto deja en `0` o `""` sin veredicto final (`timeMs`, `memoryKb`,
  `passedCases`, `totalCases`, `judgedAt`) o sin valor (`explanation`, `sourceCode` en
  listados, `email` ajeno) se devuelven como `null`.
- `Submission.user`, `Submission.problem`, `Contest.problems[].problem` se resuelven con
  llamadas batch (`GetUsers`) o por id, propagando el JWT; si fallan, el campo es `null`.
- `submissionUpdated`: se alimenta del consumidor de `submission.judged`. Al suscribirse se
  verifica que la submission sea del usuario (o que sea ADMIN) y, si ya tiene veredicto
  final, se emite de inmediato. `scoreboardUpdated` se emite por cada `submission.judged`
  con `contest_id`.

## RPCs que consume

| Servicio                              | RPCs                                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| users (`USERS_GRPC_ADDR`)             | `Register`, `Login`, `GetUser`, `GetUsers`, `GetPublicKey`                                |
| problems (`PROBLEMS_GRPC_ADDR`)       | `ListProblems`, `GetProblem`, `CreateProblem`, `UpdateProblem`, `CreateTestcaseUploadUrl` |
| submissions (`SUBMISSIONS_GRPC_ADDR`) | `CreateSubmission`, `GetSubmission`, `ListSubmissions`                                    |
| ranking (`RANKING_GRPC_ADDR`)         | `CreateContest`, `GetContest`, `ListContests`, `GetScoreboard`, `GetUserStats`            |
| mcp (`MCP_URL`)                       | MCP `tools/list` y `tools/call` (Streamable HTTP)                                         |
| Gemini (AI Studio o Vertex AI)        | Function calling: las tools del MCP se declaran como funciones (`GEMINI_MODEL`)           |

## Eventos

|         | Topic               | Detalle                                                                                                                                                                                                                                                   |
| ------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Consume | `submission.judged` | Consumer group propio (`BFF_KAFKA_GROUP_ID`). Publica el veredicto en la subscription `submissionUpdated` del cliente dueño de la submission. Con varias réplicas, cada una usa un group id único (prefijo + hostname) para recibir todos los veredictos. |
| Publica | —                   |                                                                                                                                                                                                                                                           |

## Variables de entorno

| Variable                                                                                 | Ejemplo                                                                  |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `BFF_PORT`                                                                               | `4000`                                                                   |
| `BFF_CORS_ORIGIN`                                                                        | `http://localhost:5173` (origen del front; varios separados por coma)    |
| `USERS_GRPC_ADDR` · `PROBLEMS_GRPC_ADDR` · `SUBMISSIONS_GRPC_ADDR` · `RANKING_GRPC_ADDR` | `localhost:50051` … `localhost:50054`                                    |
| `KAFKA_BROKERS`                                                                          | `localhost:9092`                                                         |
| `BFF_KAFKA_CLIENT_ID` · `BFF_KAFKA_GROUP_ID`                                             | `bff` · `bff` (prefijo; cada réplica agrega un sufijo único)             |
| `JWT_ISSUER` · `JWT_AUDIENCE`                                                            | `juez-users` · `juez`                                                    |
| `MCP_URL`                                                                                | `http://localhost:4100/mcp` (en docker `http://mcp:4100/mcp`)            |
| `GOOGLE_GENAI_USE_VERTEXAI`                                                              | `false` = Google AI Studio (API key) · `true` = Vertex AI                |
| `GEMINI_API_KEY`                                                                         | API key de Google AI Studio (solo con `GOOGLE_GENAI_USE_VERTEXAI=false`) |
| `GOOGLE_CLOUD_PROJECT` · `GOOGLE_CLOUD_LOCATION`                                         | proyecto de GCP · `us-central1` (solo Vertex AI)                         |
| `GOOGLE_APPLICATION_CREDENTIALS`                                                         | JSON de cuenta de servicio (Vertex AI; vacío = ADC de `gcloud`)          |
| `GEMINI_MODEL`                                                                           | `gemini-3.8-flash`                                                       |
| `LOG_LEVEL`                                                                              | `info`                                                                   |

Con `GOOGLE_GENAI_USE_VERTEXAI=false` el BFF debe exigir `GEMINI_API_KEY`; con `true`,
`GOOGLE_CLOUD_PROJECT` y `GOOGLE_CLOUD_LOCATION`. El SDK `@google/genai` lee estas mismas
variables. Si faltan, el BFF arranca igual y `askAssistant` responde `UNAVAILABLE`.
`GEMINI_MODEL` (`gemini-3.8-flash`) es el modelo Flash estable (GA) que la documentación de Google
lista para la Gemini API y para Vertex AI (verificado el 2026-11-22).
