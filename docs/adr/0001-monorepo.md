# ADR 0001 — Monorepo con pnpm workspaces + Turborepo

- **Estado:** Aceptada
- **Fecha:** 2026-11-10

## Contexto

El sistema tiene 2 apps y 6 servicios que comparten contratos (`.proto`), configuración
(TypeScript, ESLint, Vitest) e infraestructura local. En la fase 1 cada servicio lo construye
un agente distinto en paralelo, así que hace falta un lugar único para los contratos y reglas
claras sobre qué puede importar cada paquete.

## Decisión

- Un solo repositorio `juez-online` con **pnpm workspaces** (`apps/*`, `services/*`,
  `packages/*`) y **Turborepo** para orquestar `generate`, `build`, `lint`, `typecheck` y
  `test` respetando el grafo de dependencias y con caché.
- Paquetes compartidos: `@juez/contracts` (código generado desde `proto/`, topics y helpers de
  eventos) y `@juez/config` (tsconfig, ESLint, preset de Vitest).
- **Regla:** ningún servicio ni app importa a otro; solo pueden depender de
  `@juez/contracts` y `@juez/config`.
- Versión de pnpm fijada con `packageManager` en el `package.json` raíz (pnpm la respeta por
  sí solo y `pnpm/action-setup` la lee en CI). Node fijado con `.nvmrc` + `engines`.
- El código generado no se commitea; se regenera en el build de `@juez/contracts` y en CI.
- CI por paquete con un workflow reusable (`_service-ci.yml`) filtrado por rutas.

## Consecuencias

- Un cambio de contrato y sus consumidores se revisan en el mismo PR; `buf breaking` contra
  `main` detecta incompatibilidades.
- Los servicios siguen siendo desplegables por separado: una imagen Docker por servicio,
  publicada en GHCR.
- La regla de imports se mantiene por convención y revisión; un acoplamiento accidental no
  rompe el build automáticamente.
- Clonar el repo trae todo el sistema, aunque se trabaje en un solo servicio.

## Alternativas consideradas

- **Polyrepo** (un repo por servicio + repo de contratos publicado en un registry): aísla
  mejor, pero exige versionar y publicar `@juez/contracts` en cada cambio y coordinar PRs
  entre repos. Demasiado costoso para un taller.
- **Nx**: más funciones (generadores, reglas de límites entre módulos), pero más configuración
  y más opiniones sobre cada framework. Turborepo basta para correr tareas con caché.
