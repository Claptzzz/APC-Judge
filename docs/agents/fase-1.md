# Fase 1 — Reglas comunes para agentes de servicio

Antes de escribir código, lee: `CLAUDE.md`, `docs/architecture.md`, los ADR en `docs/adr/`,
la ficha `README.md` de tu servicio y los `.proto` que tu servicio expone o consume.
La ficha y los contratos son la fuente de verdad. Si te desvías de la ficha, documéntalo en
una sección "Desviaciones de la ficha" del README del servicio.

## Alcance

- Solo puedes modificar `services/<tu-servicio>/**` y crear `.github/workflows/<tu-servicio>.yml`.
- NO modifiques `proto/`, `packages/`, `infra/`, `pnpm-workspace.yaml`, otros servicios ni apps.
  Si necesitas un cambio fuera de tu alcance, no lo hagas: descríbelo en la sección
  "Cambios propuestos fuera de alcance" del reporte final.
- No agregues tu servicio al docker-compose; eso es la fase 2.
- Evita dependencias con código nativo o scripts de postinstall. Si una es imprescindible,
  repórtala en vez de habilitarla.
- Usa como referencia los servicios que ya están en `main` (users, problems, judge,
  submissions) para mantener patrones consistentes, pero no los modifiques.

## Implementación

- TypeScript estricto con `@juez/config` (tsconfig, ESLint y preset de Vitest).
- Configuración solo por variables de entorno, validadas con zod al arrancar. Usa los nombres
  definidos en `.env.example` y en tu ficha.
- Logs JSON con pino, con el nombre del servicio. Propaga `x-request-id` en la metadata gRPC.
- Endpoints HTTP `/health` (vivo) y `/ready` (dependencias OK).
- Apagado ordenado con SIGTERM: cerrar servidores, consumidores Kafka y pools de BD.
- Verifica el JWT RS256 en toda RPC que lo requiera, según tu ficha.
- Usa solo las credenciales de tu propia BD. Las migraciones van versionadas en el servicio,
  con un script `db:migrate`. Nunca modifiques una migración existente; crea una nueva.

## Resiliencia (obligatorio)

- Las dependencias (Kafka, otros servicios gRPC, BD) pueden no estar disponibles al arrancar.
  El servicio debe arrancar igual y reintentar en segundo plano con backoff exponencial
  (tope 30 s). Nunca captures un error de conexión solo con un warning sin reintentar.
- Los consumidores Kafka llevan su estado de readiness con los eventos de kafkajs
  (`GROUP_JOIN`, `CRASH`, `STOP`, `DISCONNECT`), como `KafkaReadiness` en
  `services/judge/src/kafka.ts`. `/ready` responde 503 si el consumidor no está unido al grupo
  o si se cayó.
- Consumidores Kafka: commit manual del offset solo después de procesar, idempotencia por
  `event_id` y DLQ para los mensajes que no se pueden deserializar.
- Los clientes gRPC llevan un timeout por llamada (alrededor de 3 s). Mapeo de errores:
  `NotFound` → `NOT_FOUND`; `Unavailable`, `DeadlineExceeded` o un error de red →
  `UNAVAILABLE`. Nunca reportes "no existe" cuando lo que pasa es que el servicio no responde.
- Nunca llames por gRPC a otro servicio mientras procesas un evento de Kafka, salvo que la
  ficha lo indique explícitamente. Usa los datos que trae el evento o los que ya guardaste.
- Las columnas de fecha que se usan en cursores de paginación van como
  `timestamp(3) with time zone`, porque JS solo tiene precisión de milisegundos.

## Tests y CI

- Vitest con cobertura ≥ 60% usando solo tests unitarios, porque el CI no levanta
  infraestructura. Mockea los clientes gRPC, Kafka, la BD y S3 donde corresponda.
- Opcional: `test:int` contra la infraestructura local (`pnpm infra:up`), excluido del CI.
- Dockerfile multi-etapa con contexto en la raíz del repo, usando `pnpm deploy --filter`,
  usuario no-root y `HEALTHCHECK`.
- Crea `.github/workflows/<tu-servicio>.yml`, que llama a `_service-ci.yml`, con filtro de paths:
  `services/<tu-servicio>/**`, `packages/contracts/**`, `packages/config/**`, `proto/**`,
  `.github/workflows/_service-ci.yml` y el propio workflow.

## macOS

- El judge depende de herramientas de Linux (`prlimit`, `unshare`); en macOS solo funciona
  dentro de Docker. Si tu servicio depende de algo exclusivo de Linux, haz que sus tests se
  salten con un mensaje claro en otras plataformas, y deja que el CI (Ubuntu) los ejecute.

## Git

- No ejecutes `git commit`, `push` ni `merge`, ni crees ramas. Nunca agregues `Co-Authored-By`.

## Criterios de aceptación (ejecútalos y reporta cada uno)

- `pnpm --filter <paquete> lint`, `typecheck`, `test` (con el % de cobertura) y `build` OK.
- `docker build` de tu imagen OK.
- El servicio arranca contra la infraestructura local y `/ready` responde OK.
- Con Kafka detenido, el servicio arranca igual, `/ready` responde 503, y al levantar Kafka
  se recupera solo.
- `actionlint` sobre tu workflow.

## Reporte final

Qué implementaste, decisiones propias (librerías y versiones), desviaciones de la ficha,
cambios propuestos fuera de alcance, lo que no pudiste verificar y un mensaje de commit sugerido.
