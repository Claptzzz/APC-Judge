# mcp — MCP server del asistente

|                     |                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Paquete**         | `@juez/mcp`                                                                                                                                                  |
| **Responsabilidad** | Exponer al asistente (Gemini en el BFF) tools de solo lectura sobre el dominio, ejecutadas con la identidad del usuario.                                     |
| **Framework**       | MCP TypeScript SDK (`@modelcontextprotocol/sdk`) con transporte **Streamable HTTP**. Clientes gRPC Connect (`@connectrpc/connect-node`) hacia los servicios. |
| **Puertos**         | HTTP **4100** (`/mcp` para MCP, `/health`). Sin gRPC propio.                                                                                                 |
| **BD**              | Ninguna.                                                                                                                                                     |

## Tools

| Tool               | Argumentos (sugeridos)                      | RPC                                                                 |
| ------------------ | ------------------------------------------- | ------------------------------------------------------------------- |
| `listar_problemas` | `tags?`, `dificultad?`, `page_token?`       | `ProblemService.ListProblems`                                       |
| `ver_problema`     | `id` o `slug`                               | `ProblemService.GetProblem`                                         |
| `mis_submissions`  | `problem_id?`, `contest_id?`, `page_token?` | `SubmissionService.ListSubmissions` con `user_id` = `sub` del token |
| `ver_submission`   | `id`                                        | `SubmissionService.GetSubmission`                                   |
| `ver_scoreboard`   | `contest_id`                                | `RankingService.GetScoreboard`                                      |

## Autenticación

El BFF llama al MCP con `Authorization: Bearer <jwt>` del usuario. El MCP verifica el token
localmente (llave de `UserService.GetPublicKey`, cacheada) y lo **propaga** en el header
`authorization` de cada llamada Connect. Nunca usa credenciales propias con más permisos.

## RPCs que expone

Ninguno gRPC; expone el protocolo MCP (`tools/list`, `tools/call`).

## RPCs que consume

| Servicio    | RPCs                               |
| ----------- | ---------------------------------- |
| users       | `GetPublicKey`                     |
| problems    | `ListProblems`, `GetProblem`       |
| submissions | `ListSubmissions`, `GetSubmission` |
| ranking     | `GetScoreboard`                    |

## Eventos

Ni publica ni consume.

## Variables de entorno

| Variable                                                                                 | Ejemplo                                                 |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `MCP_PORT`                                                                               | `4100`                                                  |
| `USERS_GRPC_ADDR` · `PROBLEMS_GRPC_ADDR` · `SUBMISSIONS_GRPC_ADDR` · `RANKING_GRPC_ADDR` | `localhost:50051` … `:50054` (Connect: `http://<addr>`) |
| `JWT_ISSUER` · `JWT_AUDIENCE`                                                            | `juez-users` · `juez`                                   |
| `LOG_LEVEL`                                                                              | `info`                                                  |
