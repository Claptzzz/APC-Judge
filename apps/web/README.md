# web — frontend

|                     |                                                                                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Paquete**         | `@juez/web`                                                                                                                                                           |
| **Responsabilidad** | SPA del juez: catálogo y enunciados, editor y envío de código, estado del veredicto en vivo, contests y scoreboard, estadísticas del usuario y chat con el asistente. |
| **Framework**       | React + Vite + Apollo Client (HTTP para queries/mutations, `graphql-ws` para subscriptions).                                                                          |
| **Puertos**         | HTTP **5173** (dev server de Vite).                                                                                                                                   |
| **BD**              | Ninguna. El JWT se guarda en el cliente y se envía en `Authorization: Bearer <jwt>` (HTTP) y en `connectionParams` (WS).                                              |

## Comunicación

- **Solo habla con el BFF** (`http://localhost:4000/graphql` y `ws://localhost:4000/graphql`).
  No usa gRPC, Kafka ni `@juez/contracts`.
- **RPCs que expone / consume:** ninguno (consume la API GraphQL del BFF).
- **Eventos:** ninguno directamente. Recibe veredictos por la subscription `submissionUpdated`.

## Variables de entorno

| Variable                | Ejemplo                         | Uso                      |
| ----------------------- | ------------------------------- | ------------------------ |
| `WEB_PORT`              | `5173`                          | Puerto del dev server.   |
| `VITE_GRAPHQL_HTTP_URL` | `http://localhost:4000/graphql` | Endpoint HTTP de Apollo. |
| `VITE_GRAPHQL_WS_URL`   | `ws://localhost:4000/graphql`   | Endpoint `graphql-ws`.   |

> Vite solo expone al navegador las variables con prefijo `VITE_`.
