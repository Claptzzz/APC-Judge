# Arquitectura de juez-online

Juez online de programación competitiva construido como microservicios en TypeScript
(taller de Arquitectura de Software, UCN). Las decisiones están en [`adr/`](adr/).

## Vista general

```mermaid
flowchart LR
  subgraph Cliente
    web["web<br/>React + Vite + Apollo"]
  end

  subgraph Edge
    bff["bff<br/>NestJS + GraphQL"]
    mcp["mcp<br/>MCP SDK (Streamable HTTP)"]
  end

  subgraph Servicios
    users["users<br/>Fastify + Connect"]
    problems["problems<br/>Express + Connect"]
    submissions["submissions<br/>NestJS híbrido"]
    ranking["ranking<br/>Hono + Connect"]
    judge["judge<br/>worker Node"]
  end

  subgraph Datos
    pgu[("PG users")]
    pgp[("PG problems")]
    pgs[("PG submissions<br/>+ outbox")]
    pgr[("PG ranking")]
    redis[("Redis")]
    minio[("MinIO<br/>testcases")]
    kafka{{"Kafka"}}
  end

  gemini(["Gemini<br/>Vertex AI"])

  web -- "GraphQL HTTP + graphql-ws" --> bff
  bff -- gRPC --> users & problems & submissions & ranking
  bff -- "MCP + JWT" --> mcp
  bff -- "function calling" --> gemini
  mcp -- "gRPC Connect + JWT" --> users & problems & submissions & ranking
  submissions -- gRPC --> problems & ranking
  ranking -- gRPC --> problems
  judge -- "GetJudgeSpec" --> problems
  judge -- "GET prefirmado" --> minio

  users --> pgu
  problems --> pgp
  problems --> minio
  submissions --> pgs
  ranking --> pgr
  ranking --> redis

  users -. "user.registered" .-> kafka
  submissions -. "submission.created (outbox)" .-> kafka
  judge -. "submission.judged" .-> kafka
  kafka -. "user.registered, submission.judged" .-> ranking
  kafka -. "submission.created" .-> judge
  kafka -. "submission.judged" .-> submissions
  kafka -. "submission.judged" .-> bff
```

Líneas sólidas: llamadas síncronas. Punteadas: eventos Kafka (valor en protobuf binario,
key = id del agregado).

## Puertos

| Componente  | HTTP | gRPC  |
| ----------- | ---- | ----- |
| web         | 5173 | —     |
| bff         | 4000 | —     |
| mcp         | 4100 | —     |
| users       | 8081 | 50051 |
| problems    | 8082 | 50052 |
| submissions | 8083 | 50053 |
| ranking     | 8084 | 50054 |
| judge       | 8085 | —     |

Infraestructura: Postgres 5432, Redis 6379, Kafka 9092 (host; `kafka:29092` dentro de la red
de docker), Kafka UI 8080, MinIO 9000 (API) / 9001 (consola).

## Componentes

| Componente  | Framework                            | Datos             | Ficha                                                     |
| ----------- | ------------------------------------ | ----------------- | --------------------------------------------------------- |
| web         | React + Vite + Apollo Client         | —                 | [apps/web](../apps/web/README.md)                         |
| bff         | NestJS + Apollo GraphQL + graphql-ws | —                 | [apps/bff](../apps/bff/README.md)                         |
| users       | Fastify + ConnectRPC                 | Postgres          | [services/users](../services/users/README.md)             |
| problems    | Express + ConnectRPC                 | Postgres + MinIO  | [services/problems](../services/problems/README.md)       |
| submissions | NestJS híbrido (gRPC + Kafka + HTTP) | Postgres + outbox | [services/submissions](../services/submissions/README.md) |
| ranking     | Hono + ConnectRPC                    | Postgres + Redis  | [services/ranking](../services/ranking/README.md)         |
| judge       | Node sin framework (`node:http`)     | —                 | [services/judge](../services/judge/README.md)             |
| mcp         | MCP TypeScript SDK                   | —                 | [services/mcp](../services/mcp/README.md)                 |

**gRPC en servicios no-Nest:** se sirve con `@connectrpc/connect-node` en un servidor
**HTTP/2 separado** del framework web, porque los clientes `@grpc/grpc-js` del BFF y de
submissions requieren HTTP/2. El framework web atiende `/health` y `/metrics`.

**Kafka:** todos usan `kafkajs` (el mismo cliente que usa `@nestjs/microservices`).

## Contratos

- Fuente única: [`proto/`](../proto) (buf v2, lint STANDARD, breaking FILE contra `main`).
- `@juez/contracts` genera, en su build, `src/gen/es` (protobuf-es v2, para Connect y para
  serializar eventos) y `src/gen/nest` (ts-proto `nestJs=true`, para Nest). El código
  generado no se commitea.
- Paquetes: `juez.common.v1`, `juez.users.v1`, `juez.problems.v1`, `juez.submissions.v1`,
  `juez.ranking.v1`, `juez.events.v1`.

### Autenticación entre servicios

- `users` firma JWT **RS256** (claims `sub`, `username`, `role`, `iss`, `aud`, `iat`, `exp`;
  header `kid`) y expone la llave pública con `UserService.GetPublicKey`.
- El JWT del usuario viaja en la **metadata gRPC `authorization`** con el valor
  `Bearer <jwt>` (constante `AUTH_METADATA_KEY` de `@juez/contracts`):
  - `@grpc/grpc-js` / Nest: `const md = new Metadata(); md.set('authorization', 'Bearer ' + jwt)`.
  - Connect: header `Authorization: Bearer <jwt>` (en HTTP/2 los headers van en minúscula, así
    que es la misma clave).
- bff y mcp verifican el token localmente. Cada servicio que lee el token (`sub`, `role`) lo
  verifica también con la misma llave pública (cacheada al arrancar).
- RPCs sin JWT: `Register`, `Login`, `GetPublicKey` (públicas) y `GetJudgeSpec` (interna del
  judge; se restringe por red).

### Eventos

| Topic                | Mensaje             | Key             | Productor            | Consumidores (group)      |
| -------------------- | ------------------- | --------------- | -------------------- | ------------------------- |
| `user.registered`    | `UserRegistered`    | `user_id`       | users                | ranking                   |
| `submission.created` | `SubmissionCreated` | `submission_id` | submissions (outbox) | judge                     |
| `submission.judged`  | `SubmissionJudged`  | `submission_id` | judge                | submissions, ranking, bff |

Cada topic tiene 3 particiones y su DLQ `<topic>.dlq`. Los consumidores son idempotentes por
`event_id`. `encodeEvent(topic, evento)` devuelve `{ key, value, headers, event }` listo para
kafkajs y `decodeEvent(topic, value)` acepta el topic base o su DLQ.

## Flujo de una submission

```mermaid
sequenceDiagram
  autonumber
  actor U as Usuario
  participant W as web
  participant B as bff
  participant S as submissions
  participant K as Kafka
  participant J as judge
  participant P as problems
  participant M as MinIO
  participant R as ranking

  U->>W: Envía código
  W->>B: mutation submit (Authorization: Bearer jwt)
  B->>B: Verifica JWT (llave pública cacheada)
  W-)B: subscription submissionUpdated(id) por graphql-ws
  B->>S: CreateSubmission (metadata authorization)
  S->>P: GetProblem (¿existe y publicado?)
  S->>S: TX: INSERT submission PENDING + INSERT outbox
  S-->>B: Submission (PENDING)
  B-->>W: id + PENDING
  S->>K: relay del outbox: submission.created (key submission_id)
  K->>J: submission.created (group judge)
  J->>P: GetJudgeSpec(problem_id)
  P-->>J: límites + URLs prefirmadas
  J->>M: GET input/output de cada caso
  J->>J: compila y ejecuta en sandbox (sin red, con límites)
  J->>K: submission.judged (event_id determinista)
  par Consumidores independientes
    K->>S: submission.judged → actualiza veredicto (dedupe event_id)
  and
    K->>R: submission.judged → scoreboard + stats en Redis (dedupe event_id)
  and
    K->>B: submission.judged (group propio del bff)
    B-->>W: submissionUpdated (veredicto)
  end
```

1. El usuario envía el código; el frontend llama a la mutation `submit` con el JWT.
2. El BFF verifica el JWT localmente y llama a `SubmissionService.CreateSubmission`
   propagando el token en la metadata `authorization`.
3. submissions toma `user_id` del token, valida el problema (y el contest, si viene) y en
   **una transacción** inserta la submission `PENDING` y la fila del outbox con el
   `SubmissionCreated` ya serializado. Responde de inmediato.
4. El relay del outbox publica `submission.created` (key `submission_id`) y marca la fila
   como enviada. Si el proceso cae entre publicar y marcar, el evento se reenvía
   (_at-least-once_).
5. El judge consume el evento, pide `GetJudgeSpec`, descarga los casos con las URLs
   prefirmadas, compila y ejecuta en el sandbox y publica `submission.judged` con un
   `event_id` derivado del `submission_id`, así un reproceso genera el mismo evento.
6. Tres consumer groups independientes reaccionan: **submissions** guarda el veredicto,
   **ranking** actualiza scoreboard y estadísticas, y **bff** empuja `submissionUpdated` al
   cliente por WebSocket. Todos deduplican por `event_id`.
7. Si un consumidor falla de forma persistente, tras N reintentos envía el mensaje a
   `<topic>.dlq` para inspección (Kafka UI en `localhost:8080`).

## Flujo del asistente (MCP)

```mermaid
sequenceDiagram
  autonumber
  actor U as Usuario
  participant W as web
  participant B as bff (cliente MCP)
  participant G as Gemini (Vertex AI)
  participant X as mcp (MCP server)
  participant R as ranking

  U->>W: "¿Cómo voy en el contest X?"
  W->>B: mutation askAssistant (Authorization: Bearer jwt)
  B->>X: tools/list (Streamable HTTP, Authorization: Bearer jwt)
  X-->>B: listar_problemas, ver_problema, mis_submissions, ver_submission, ver_scoreboard
  B->>G: prompt + historial + tools como function declarations
  G-->>B: functionCall ver_scoreboard({contest_id})
  B->>X: tools/call ver_scoreboard (Authorization: Bearer jwt)
  X->>X: verifica JWT
  X->>R: GetScoreboard (Connect, authorization propagado)
  R-->>X: filas del scoreboard
  X-->>B: resultado de la tool
  B->>G: functionResponse
  G-->>B: respuesta en lenguaje natural
  B-->>W: respuesta del asistente
```

1. El usuario pregunta en el chat; el frontend llama al BFF con su JWT.
2. El BFF, como **cliente MCP** (transporte Streamable HTTP), obtiene la lista de tools del
   MCP server enviando el JWT del usuario en `Authorization`.
3. El BFF llama a Gemini (Vertex AI) con la conversación y las tools declaradas como
   funciones.
4. Si Gemini pide una tool, el BFF la ejecuta con `tools/call` en el MCP server.
5. El MCP server verifica el JWT y llama al servicio correspondiente por gRPC (cliente
   Connect) **propagando el mismo token**: el asistente solo ve lo que el usuario puede ver
   (por ejemplo, `mis_submissions` filtra por el `sub` del token).
6. El resultado vuelve a Gemini, que puede pedir más tools o responder; el BFF devuelve la
   respuesta final al frontend.

## Infraestructura local

`pnpm infra:up` levanta `infra/docker-compose.yml` y espera a que todo quede healthy:
Kafka (KRaft, un nodo) + `kafka-init` (topics y DLQ), Kafka UI, PostgreSQL (una instancia;
una BD y un usuario por servicio, sin acceso cruzado), Redis, MinIO + `minio-init`
(bucket privado `testcases`). En Kubernetes cada servicio tiene su propia instancia de BD
([ADR 0005](adr/0005-bd-por-servicio.md)).
