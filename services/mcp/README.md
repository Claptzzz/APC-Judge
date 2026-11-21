# mcp — MCP server del asistente

|                     |                                                                                                                                                                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Paquete**         | `@juez/mcp`                                                                                                                                                                                                                                                     |
| **Responsabilidad** | Exponer al asistente (Gemini en el BFF) tools de solo lectura sobre el dominio, ejecutadas con la identidad del usuario.                                                                                                                                        |
| **Framework**       | MCP TypeScript SDK **v2** (`@modelcontextprotocol/server` + `@modelcontextprotocol/node`, ver [desviaciones](#desviaciones-de-la-ficha)) con transporte **Streamable HTTP** sin estado. Clientes gRPC Connect (`@connectrpc/connect-node`) hacia los servicios. |
| **Puertos**         | HTTP **4100** (`/mcp` para MCP, `/health`, `/ready`). Sin gRPC propio.                                                                                                                                                                                          |
| **BD**              | Ninguna.                                                                                                                                                                                                                                                        |

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

Opcionales (no están en `.env.example`; todas tienen valor por defecto):

| Variable                  | Por defecto                 | Para qué                                                                                                                                               |
| ------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MCP_HOST`                | `0.0.0.0`                   | Dirección de escucha.                                                                                                                                  |
| `MCP_ALLOWED_HOSTS`       | `localhost,127.0.0.1,[::1]` | Hostnames (sin puerto) aceptados en el header `Host` de `/mcp` (protección contra DNS rebinding del SDK). En docker/k8s agrega el nombre del servicio. |
| `MCP_ALLOWED_ORIGINS`     | _(vacío)_                   | Hostnames aceptados en `Origin`. Vacío: se rechaza toda request con `Origin` (navegadores); el BFF llama desde el servidor, sin `Origin`.              |
| `MCP_MAX_BODY_BYTES`      | `262144` (256 KiB)          | Límite del body de `/mcp` (413 por encima).                                                                                                            |
| `MCP_UPSTREAM_TIMEOUT_MS` | `3000`                      | Timeout por llamada gRPC (incluida `GetPublicKey`).                                                                                                    |

## Implementación

- **Transporte:** `createMcpHandler` del SDK (Streamable HTTP **sin estado**: un `McpServer` nuevo
  por request, sin sesiones) montado en `node:http` con `toNodeHandler`. Sirve clientes de la
  spec 2026-07-28 y, en modo `legacy: 'stateless'` (por defecto), también clientes 2025
  (`initialize` clásico), así que el BFF puede usar el cliente v1 o v2 del SDK.
- **Orden en `/mcp`:** validación de `Host` y `Origin` del SDK (403) → `Authorization: Bearer`
  (401) → límite de body (413) → handler MCP.
- **Autenticación:** JWT RS256 verificado localmente con la llave de `GetPublicKey`, cacheada.
  Al arrancar se pide sin bloquear; si users no responde se reintenta en segundo plano (1 s,
  2 s, 4 s… tope 30 s) y también en cada request. Sin token o con token inválido/expirado →
  **401** con `WWW-Authenticate: Bearer`. Si todavía no hay llave porque users no responde →
  **503** con `Retry-After` (no es culpa del token).
- **Identidad delegada:** el JWT del usuario se propaga en `authorization` de cada llamada
  Connect, junto con `x-request-id` (el que trae el request o uno nuevo). Timeout de 3 s por
  llamada.
- **`/ready`:** 200 cuando la llave pública de users está cargada; no depende de problems,
  submissions ni ranking (si caen, las tools lo informan como error).

## Tools (todas `readOnlyHint: true`)

| Tool               | Argumentos                                                                      | Notas                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listar_problemas` | `tags?`, `dificultad?` (`facil`/`media`/`dificil`), `page_size?`, `page_token?` | Sin enunciados.                                                                                                                                                           |
| `ver_problema`     | `id` **o** `slug` (exactamente uno)                                             | Enunciado truncado a 4.000 caracteres con aviso (`statement_truncated` en `structuredContent`).                                                                           |
| `mis_submissions`  | `problem_id?`, `contest_id?`, `page_size?`, `page_token?`                       | `user_id` **siempre** es el `sub` del token; un `user_id` en los argumentos se ignora.                                                                                    |
| `ver_submission`   | `id`                                                                            | Resumen del veredicto (casos pasados/totales, tiempo y memoria comparados con los límites del problema, explicación del veredicto) y código (truncado) si es del usuario. |
| `ver_scoreboard`   | `contest_id`, `page_size?`, `page_token?`                                       | Problemas etiquetados P1, P2… con leyenda; marca la fila del usuario.                                                                                                     |

Cada tool responde con texto compacto para el LLM y `structuredContent` con los datos. Los
errores de los servicios vuelven como resultado de tool con `isError: true` (no como error de
protocolo), para que el LLM pueda reaccionar:

| Error del servicio                               | Mensaje                                                        |
| ------------------------------------------------ | -------------------------------------------------------------- |
| `NotFound` (o respuesta sin el recurso)          | “El problema … no existe.”, “La submission … no existe.”, etc. |
| `Unavailable`, `DeadlineExceeded` o error de red | “El servicio de ranking no responde en este momento…”          |
| `PermissionDenied` · `Unauthenticated`           | Sin permiso · sesión rechazada                                 |
| `InvalidArgument` · `FailedPrecondition`         | Se incluye el detalle del servicio                             |
| Argumentos que no cumplen el esquema             | Error de validación del SDK (también `isError`)                |

## Tests

`pnpm --filter @juez/mcp test`: el cliente MCP del propio SDK (`@modelcontextprotocol/client`)
contra el servidor HTTP real en un puerto local, con los clientes Connect mockeados, en las dos
eras de protocolo (2025 y 2026-07-28). Cubre `tools/list`, cada tool, 401/503, propagación del
token, que `mis_submissions` ignore un `user_id` ajeno, el mapeo de errores a `isError`, Host,
Origin y límite de body. El verificador JWT también se prueba contra sockets reales (puerto
cerrado y servidor que no responde).

## Desviaciones de la ficha

- **SDK v2 en vez de `@modelcontextprotocol/sdk`.** La ficha nombra el paquete único
  `@modelcontextprotocol/sdk`, que hoy es la línea **v1 de mantenimiento** (solo correcciones
  hasta ~2027-01, sin la spec 2026-07-28). La versión estable actual es la **v2**, publicada
  como paquetes separados: se usa `@modelcontextprotocol/server@2.4.0` y
  `@modelcontextprotocol/node@2.1.2` (y `@modelcontextprotocol/client@2.4.0` en los tests). Es
  el mismo SDK oficial; el endpoint sigue siendo Streamable HTTP y acepta clientes v1.
- **`/ready`** no estaba en la ficha (solo `/health`); se agrega según la guía de la fase 1.
- **Variables opcionales** `MCP_HOST`, `MCP_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGINS`,
  `MCP_MAX_BODY_BYTES` y `MCP_UPSTREAM_TIMEOUT_MS`, con valores por defecto.
- **`ver_submission`** consulta además `ProblemService.GetProblem` (best effort) para comparar
  tiempo y memoria con los límites del problema.
- **Argumentos extra** `page_size` en los listados y `page_token` en `ver_scoreboard`.
