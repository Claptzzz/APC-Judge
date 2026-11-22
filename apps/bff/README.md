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

Opcionales (no están en `.env.example`; todas tienen valor por defecto):

| Variable                              | Por defecto | Para qué                                                                   |
| ------------------------------------- | ----------- | -------------------------------------------------------------------------- |
| `BFF_GRPC_TIMEOUT_MS`                 | `3000`      | Deadline de cada llamada gRPC.                                             |
| `BFF_GRAPHQL_MAX_DEPTH`               | `10`        | Profundidad máxima de una operación (se ignoran los campos `__*`).         |
| `BFF_ASSISTANT_RATE_LIMIT_PER_MINUTE` | `10`        | Preguntas por usuario y minuto a `askAssistant` (en memoria, por réplica). |
| `BFF_ASSISTANT_TIMEOUT_MS`            | `30000`     | Tiempo total de una pregunta (MCP + todas las rondas de Gemini).           |
| `BFF_ASSISTANT_MAX_ROUNDS`            | `5`         | Rondas de function calling antes de pedir una respuesta final sin tools.   |

## Implementación

- **Stack:** NestJS 12 + `@nestjs/graphql`/`@nestjs/apollo` 14 + Apollo Server 5 (graphql 16,
  que es lo que exige Apollo Server 5) sobre express 5. Schema-first con
  `typePaths: [GRAPHQL_SCHEMA_PATH]`; el escalar `DateTime` se implementa en
  `src/graphql/scalars.ts`.
- **Tipos del schema:** `scripts/codegen.mjs` genera `src/gen/graphql.ts` con
  `@graphql-codegen/core` + plugin `typescript` (enums como uniones de strings, solo tipos). No
  se commitea; `build` y `typecheck` lo regeneran antes de compilar.
- **gRPC:** `ClientGrpcProxy` de `@nestjs/microservices` por servicio, con el `.proto` de
  `@juez/contracts/proto` cargado por `@grpc/proto-loader` y los tipos de
  `@juez/contracts/nest`. Opciones del loader compatibles con ts-proto: camelCase, enums
  numéricos, int64 como string, valores por defecto presentes y oneofs aplanados
  (`src/grpc/backend.ts`). Cada llamada lleva `authorization: Bearer <jwt>` (si hay sesión),
  `x-request-id` y un deadline de 3 s.
- **Errores** (`src/grpc/errors.ts`): `NOT_FOUND` → `NOT_FOUND`; `UNAVAILABLE`,
  `DEADLINE_EXCEEDED`, `CANCELLED`, `RESOURCE_EXHAUSTED` o error de red → `UNAVAILABLE` con
  “El servicio de X no responde en este momento; reintenta más tarde.”; `UNAUTHENTICATED` →
  `UNAUTHENTICATED`; `PERMISSION_DENIED` → `FORBIDDEN`; `INVALID_ARGUMENT`,
  `FAILED_PRECONDITION`, `OUT_OF_RANGE` → `BAD_USER_INPUT`; `ALREADY_EXISTS` → `CONFLICT`;
  el resto → `INTERNAL_SERVER_ERROR` sin el detalle del servicio. Las queries de detalle
  (`user`, `problem`, `submission`, `contest`) devuelven `null` ante `NOT_FOUND`. Los errores
  inesperados se registran una vez y llegan al cliente como “Error interno del servidor.”.
- **Autenticación** (`src/auth/jwt-verifier.ts`, `src/graphql/context.ts`): la llave se pide con
  `GetPublicKey` al arrancar sin bloquear y se reintenta con backoff (1 s, 2 s, 4 s… tope 30 s).
  Un `kid` distinto al cacheado fuerza un refresco (como mucho cada 10 s; si falla se conserva
  la llave anterior). Sin llave, las operaciones con token responden `UNAVAILABLE` (no
  `UNAUTHENTICATED`). En operaciones públicas, un token inválido también es `UNAUTHENTICATED`.
- **Relaciones nullable** (`Submission.user/problem/contest`, `ContestProblem.problem`): se
  resuelven con DataLoaders por request (`GetUsers` en lote; `GetProblem` y `GetContest`
  deduplicados por id). Si el servicio falla, el campo queda en `null` con un `warn` en el log.
- **Subscriptions** (graphql-ws en `/graphql`): `onConnect` rechaza (cierre 4403) un token
  inválido en `connectionParams.authorization`; sin token, la conexión se acepta y cada
  operación responde `UNAUTHENTICATED`. El contexto se arma por operación (el token se verifica
  en cada `subscribe`).
  - `submissionUpdated(id)`: primero escucha el canal del PubSub y después consulta
    `GetSubmission` (así no pierde un veredicto que llegue entremedio); exige dueño o ADMIN
    (`FORBIDDEN`), emite el estado actual si ya es final y luego cada cambio, descartando un
    evento que repite el estado ya emitido. Los eventos se aplican sobre la submission leída
    al suscribirse (sin llamadas gRPC por evento).
  - `scoreboardUpdated(contestId)`: un aviso por cada `submission.judged` con ese `contest_id`.
  - Al cancelar, el iterador cierra primero la fuente del PubSub (un async generator suspendido
    en un `await` no ejecuta su `finally` hasta el siguiente `yield`).
- **Consumidor Kafka** (`src/kafka/judged.consumer.ts`): kafkajs directo, group
  `${BFF_KAFKA_GROUP_ID}-<hostname>`, `fromBeginning: false`, commit manual después de publicar
  en el PubSub en memoria, duplicados descartados por `event_id` (últimos 10.000), arranque con
  backoff (tope 30 s) y readiness por `GROUP_JOIN`/`CRASH`/`STOP`/`DISCONNECT`.
- **Asistente** (`src/assistant/`): por pregunta se abre un cliente MCP v2
  (`@modelcontextprotocol/client`, Streamable HTTP, negociación `auto`) contra `MCP_URL` con
  `Authorization: Bearer <jwt del usuario>` y `x-request-id`; `tools/list` se convierte en
  `functionDeclarations` de Gemini (`parametersJsonSchema` = el JSON Schema de la tool sin
  `$schema`). Ciclo de function calling con `@google/genai` (API key o Vertex AI): hasta 5
  rondas de tools; al llegar al tope se pide una última respuesta con
  `functionCallingConfig.mode = NONE`. El contenido del modelo se devuelve tal cual en cada
  ronda (conserva las _thought signatures_). Una tool que no está en `tools/list` no se
  ejecuta. Timeout total de 30 s (aborta Gemini y MCP), rate limit de 10 preguntas por minuto
  por usuario, mensajes de hasta 4.000 caracteres y los últimos 20 del historial. El prompt de
  sistema (`src/assistant/prompt.ts`) prohíbe entregar soluciones completas o código que
  resuelva el problema.
- **Seguridad:** CORS desde `BFF_CORS_ORIGIN`; límite de profundidad; introspección y GraphiQL
  solo fuera de producción; sin stacktraces en producción; body JSON de hasta 1 MB (enunciados
  de 100.000 caracteres).
- **Operación:** `/health` (vivo), `/ready` (llave pública cargada **y** consumidor unido al
  grupo; Gemini y MCP no cuentan), `/metrics` (Prometheus). Logs JSON con pino (también los
  de Nest). Apagado ordenado con SIGTERM (consumidor Kafka, clientes gRPC, servidor HTTP/WS).

## Desarrollo

```sh
pnpm --filter @juez/bff build        # genera src/gen/graphql.ts y compila
pnpm --filter @juez/bff start:dev    # usa .env.example + .env de la raíz
pnpm --filter @juez/bff test         # vitest + cobertura (umbral 60 %)
docker build -f apps/bff/Dockerfile -t juez-bff .
```

## Tests

`pnpm --filter @juez/bff test` no necesita infraestructura:

- `src/graphql.e2e.test.ts`: la app real (Nest + Apollo + express) con el backend gRPC
  mockeado: autenticación, propagación del token y `x-request-id`, mapeo de errores, `null`
  en detalles inexistentes, relaciones nullable, DataLoader, roles, fechas, profundidad,
  introspección en producción, CORS, `/ready` y `ASSISTANT_DISABLED`.
- `src/subscriptions.e2e.test.ts`: cliente `graphql-ws` real: veredicto en vivo, emisión
  inmediata si ya hay veredicto, `FORBIDDEN` para otro usuario, `NOT_FOUND`, sin token, token
  inválido (4403), liberación del PubSub al cancelar y `scoreboardUpdated`.
- `src/grpc/backend.test.ts`: los clientes de Nest contra un servidor `@grpc/grpc-js` real
  (metadata, deadline, opciones del proto-loader, mapeo de códigos).
- `src/assistant/*.test.ts`: ciclo del asistente con Gemini y MCP mockeados (tope de rondas,
  rate limit, timeout, errores de tools), el adaptador de `@google/genai` y el cliente MCP
  contra un MCP server v2 real en un puerto local.
- `src/kafka`, `src/auth`, `src/config`, mappers, escalar y PubSub.

## Desviaciones de la ficha

- **`askAssistant` sin Gemini responde `ASSISTANT_DISABLED`** (no `UNAVAILABLE`), para que el
  frontend distinga “deshabilitado en este servidor” de “caído, reintenta”. El rate limit
  responde **`RATE_LIMITED`** con `extensions.retryAfterSeconds`. Ninguno de los dos códigos
  está todavía en la lista de errores del schema.
- **Consumer group por réplica y sin `fromBeginning`.** El group es
  `${BFF_KAFKA_GROUP_ID}-<hostname>` (la ficha ya lo pedía) y la suscripción usa
  `fromBeginning: false`. Cada réplica tiene que recibir **todos** los veredictos porque
  solo ella conoce a sus clientes WebSocket; con un group compartido, Kafka repartiría las
  particiones y cada réplica vería solo una parte. Sin `fromBeginning`, un group nuevo
  (cada pod nuevo tiene otro hostname) empieza en el final del topic en vez de reproducir todo
  el historial; lo que pasó mientras el BFF no estaba no se pierde para el cliente, porque
  `submissionUpdated` emite el estado actual al suscribirse. Costo: cada réplica que muere
  deja un group huérfano que Kafka borra al vencer `offsets.retention.minutes`; dos procesos
  en el mismo host con el mismo prefijo compartirían group (usar otro `BFF_KAFKA_GROUP_ID`).
- **Sin DLQ en el BFF.** Un mensaje que no se puede deserializar se registra y se salta
  (commit). submissions y ranking ya lo mandan a `submission.judged.dlq`; si el BFF también lo
  hiciera, la DLQ tendría una copia extra por réplica. La deduplicación por `event_id` es en
  memoria (el BFF no tiene BD y un duplicado solo repetiría un aviso).
- **`/ready`** agregado (la ficha solo nombraba `/health` y `/metrics`), según la guía de la
  fase 1.
- **Variables opcionales** `BFF_GRPC_TIMEOUT_MS`, `BFF_GRAPHQL_MAX_DEPTH`,
  `BFF_ASSISTANT_RATE_LIMIT_PER_MINUTE`, `BFF_ASSISTANT_TIMEOUT_MS` y
  `BFF_ASSISTANT_MAX_ROUNDS`, con valores por defecto.
- **`ContestProblem.problem` y `Submission.problem` usan `GetProblem` por id** (deduplicado
  con DataLoader): problems no tiene un RPC en lote.
