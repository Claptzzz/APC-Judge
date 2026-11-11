# ADR 0006 — MCP server como servicio consumido por el BFF

- **Estado:** Aceptada
- **Fecha:** 2026-11-10

## Contexto

La app incluye un asistente (Gemini vía Vertex AI) que responde preguntas sobre problemas,
submissions y scoreboards. El LLM necesita herramientas para consultar datos reales con la
identidad del usuario y sin saltarse los permisos.

## Decisión

- Un servicio **`mcp`** implementa un **MCP server** con el TypeScript SDK y transporte
  **Streamable HTTP** (puerto 4100). Expone tools de solo lectura: `listar_problemas`,
  `ver_problema`, `mis_submissions`, `ver_submission`, `ver_scoreboard`.
- El **BFF es el cliente MCP**: lista las tools, las declara a Gemini como funciones y
  ejecuta las llamadas que el modelo pida (`tools/call`).
- **Identidad delegada:** el BFF envía al MCP el JWT del usuario (`Authorization: Bearer`);
  el MCP lo verifica localmente y lo propaga en la metadata `authorization` de cada llamada
  gRPC (Connect) a los servicios. No hay credenciales de servicio con más privilegios.
- El frontend nunca habla con el MCP ni con Gemini directamente.

## Consecuencias

- Las tools viven en un servicio propio, desacoplado del BFF y del proveedor de LLM: cambiar
  de modelo no toca las tools y otros clientes MCP podrían reutilizarlas.
- El asistente no puede ver más de lo que ve el usuario: los servicios aplican sus reglas de
  autorización a la misma identidad.
- Agrega un salto de red y un servicio que desplegar.
- Las tools son de solo lectura; cualquier acción con efectos (p. ej. enviar código) requiere
  un ADR nuevo y confirmación explícita del usuario.

## Alternativas consideradas

- **Function calling implementado dentro del BFF:** menos piezas, pero mezcla la lógica de
  las tools con la API GraphQL y no es reutilizable.
- **Que el frontend sea el cliente MCP:** expondría el MCP y el LLM al navegador.
- **MCP con credenciales propias de servicio:** más simple, pero rompe el principio de menor
  privilegio.
