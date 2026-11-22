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
- **Eventos:** ninguno directamente. Recibe veredictos por la subscription `submissionUpdated`
  y la señal `scoreboardUpdated(contestId)`, ante la que vuelve a pedir `scoreboard`.

## API

El contrato es el schema GraphQL de
[`packages/contracts/graphql/schema.graphql`](../../packages/contracts/graphql/schema.graphql)
(cada operación documenta quién puede usarla). Los tipos del cliente se generan desde ese
archivo (p. ej. GraphQL Code Generator); es lo único que el frontend toma del monorepo.

## Variables de entorno

| Variable              | Ejemplo                         | Uso                      |
| --------------------- | ------------------------------- | ------------------------ |
| `WEB_PORT`            | `5173`                          | Puerto del dev server.   |
| `VITE_GRAPHQL_URL`    | `http://localhost:4000/graphql` | Endpoint HTTP de Apollo. |
| `VITE_GRAPHQL_WS_URL` | `ws://localhost:4000/graphql`   | Endpoint `graphql-ws`.   |

> Vite solo expone al navegador las variables con prefijo `VITE_`.

## Desarrollo

```sh
pnpm --filter @juez/web dev        # genera los tipos y levanta Vite en :5173
pnpm --filter @juez/web test       # Vitest + Testing Library con MockedProvider (cobertura ≥ 60 %)
pnpm --filter @juez/web build      # codegen + typecheck + estáticos en dist/
```

- **URLs.** Por defecto el front usa `/graphql` **relativo** y deriva la URL de WebSocket de
  `window.location` (`http` → `ws`, `https` → `wss`). En desarrollo, el proxy de Vite reenvía
  `/graphql` (HTTP y WS) a `http://localhost:4000` (`BFF_PROXY_TARGET` para cambiarlo).
  `VITE_GRAPHQL_URL` / `VITE_GRAPHQL_WS_URL` solo sobrescriben si están definidas (en
  `apps/web/.env.local` o en el entorno del build); si solo se define la HTTP, la WS se deriva
  de ella.
- **Tipos.** `pnpm generate` (GraphQL Code Generator, client preset) lee
  `packages/contracts/graphql/schema.graphql` y las operaciones `graphql()` de
  `src/graphql/operations.ts`, y escribe `src/gen/` (ignorado por git). `dev`, `build`,
  `typecheck` y `test` lo ejecutan antes. `turbo.json` del paquete declara el schema como input
  de `generate` para que la cache de turbo no sirva tipos viejos.
- **Sesión.** `{ token, expiresAt, user }` en `localStorage` (`juez.session`). El token va en
  `Authorization: Bearer` (HTTP) y en `connectionParams.authorization` (WS). Al iniciar o
  cerrar sesión se reabre el WebSocket; el logout borra la sesión y hace `clearStore()` de
  Apollo. La sesión se revalida con `me` al cargar (y se refresca el rol), se cierra sola al
  vencer `expiresAt` y ante cualquier `UNAUTHENTICATED` del servidor.

## Pantallas

| Ruta                         | Acceso       | Contenido                                                                       |
| ---------------------------- | ------------ | ------------------------------------------------------------------------------- |
| `/login`, `/register`        | público      | Formularios con validación local y errores traducidos.                          |
| `/problems`                  | público      | Catálogo con filtros por tags y dificultad (en la URL) y paginación por token.  |
| `/problems/:slug`            | público      | Enunciado Markdown, ejemplos, límites; editor CodeMirror y envío (`?contest=`). |
| `/submissions`               | autenticado  | Mis envíos.                                                                     |
| `/submissions/:id`           | autenticado  | Veredicto en vivo (`submissionUpdated`); polling cada 3 s si el WS falla.       |
| `/contests`, `/contests/:id` | autenticado  | Listado por estado; detalle con cuenta regresiva y scoreboard ICPC.             |
| `/assistant`                 | autenticado  | Chat con `askAssistant`, historial en `sessionStorage`, chips de tools.         |
| `/profile`                   | autenticado  | `userStats`.                                                                    |
| `/admin/problems/new`        | SETTER/ADMIN | Crear problema.                                                                 |
| `/admin/problems/:slug/edit` | autor/ADMIN  | Editar, publicar y subir casos (`PUT` directo a la URL prefirmada).             |
| `/admin/contests/new`        | SETTER/ADMIN | Crear contest eligiendo y ordenando problemas del catálogo.                     |

El scoreboard se vuelve a pedir ante `scoreboardUpdated` con un debounce de 1,5 s. Todas las
vistas tienen estados de carga, vacío y error; los errores se traducen desde
`extensions.code` (`src/lib/errors.ts`). Tema claro/oscuro/sistema (Tailwind, clase `dark`).

## Contenedor

`Dockerfile` multi-etapa (contexto en la raíz): compila con Node 26 y sirve `dist/` con
`nginxinc/nginx-unprivileged` (usuario 101, puerto **8080**).

```sh
docker build -f apps/web/Dockerfile -t juez-web .
docker run --rm -p 8080:8080 -e BFF_UPSTREAM=bff:4000 juez-web
```

- nginx hace proxy de `/graphql` (HTTP y WebSocket) a `BFF_UPSTREAM` (por defecto
  `bff:4000`) con la plantilla `nginx/default.conf.template` (envsubst de la imagen oficial).
- El upstream se resuelve en cada request con los resolvers de `/etc/resolv.conf`
  (`NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1`): nginx arranca aunque el BFF no exista todavía
  (responde 502) y se recupera solo cuando aparece.
- Fallback a `index.html` para las rutas del router, cache larga para `/assets/`, `no-cache`
  para el HTML y `GET /healthz` para el `HEALTHCHECK`.

## Desviaciones de la ficha

- **URLs por defecto relativas.** La ficha lista `VITE_GRAPHQL_URL`/`VITE_GRAPHQL_WS_URL`
  apuntando a `localhost:4000`; el front ahora usa `/graphql` relativo (proxy de Vite o de
  nginx) y esas variables son solo overrides. Vite no lee el `.env.example` de la raíz.
- **Puerto del contenedor 8080** (nginx no-root). El 5173 sigue siendo el del dev server.
- **Códigos de error del asistente.** Se manejan `ASSISTANT_DISABLED` y el rate limit
  (`RATE_LIMITED`, con alias `TOO_MANY_REQUESTS`/`RATE_LIMIT_EXCEEDED` y HTTP 429; si viene
  `extensions.retryAfterSeconds` se muestra una cuenta regresiva), aunque el schema todavía no
  los documenta.
