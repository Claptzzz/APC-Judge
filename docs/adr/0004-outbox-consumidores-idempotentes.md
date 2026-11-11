# ADR 0004 — Outbox + consumidores idempotentes

- **Estado:** Aceptada
- **Fecha:** 2026-11-10

## Contexto

`CreateSubmission` debe guardar la submission **y** publicar `submission.created`. Hacer las
dos cosas por separado (_dual write_) puede dejar una submission sin evento (nunca se juzga)
o un evento sin submission. Kafka además entrega _at-least-once_: cualquier consumidor puede
recibir duplicados tras un rebalanceo o un reintento.

## Decisión

**Productor — transactional outbox (submissions):**

- En la misma transacción de Postgres se insertan la submission y una fila en `outbox`
  (`id`, `topic`, `key`, `payload` bytea con el protobuf de `encodeEvent`, `headers`,
  `created_at`, `published_at`).
- Un relay en el mismo proceso lee filas pendientes en lotes (`FOR UPDATE SKIP LOCKED`),
  publica en Kafka y marca `published_at`. Si cae entre publicar y marcar, reenvía:
  duplicado posible, pérdida no.

**Consumidores — idempotencia por `event_id`:**

- Antes de aplicar un evento se registra su `event_id` (tabla `processed_events` con PK, en la
  misma transacción que el efecto, o `SET NX` en Redis para ranking). Si ya existía, se
  descarta y se hace commit del offset.
- El **judge**, que no tiene BD, es idempotente por diseño: el `event_id` de
  `SubmissionJudged` se deriva de forma determinista del `submission_id`, así un reproceso
  produce el mismo evento y los consumidores lo descartan.
- Las actualizaciones también son seguras de reaplicar (p. ej. submissions solo actualiza si
  el veredicto actual no es final).
- **DLQ:** tras N reintentos con backoff, el mensaje se publica en `<topic>.dlq` con headers
  de error y se hace commit del offset original, para no bloquear la partición.

## Consecuencias

- Ninguna submission queda sin evento, aunque Kafka no esté disponible al crearla.
- Hay latencia extra (intervalo de polling del relay, `SUBMISSIONS_OUTBOX_POLL_INTERVAL_MS`).
- La tabla outbox crece: purgar periódicamente las filas publicadas.
- Cada consumidor mantiene su registro de eventos procesados.
- users publica `user.registered`; se recomienda aplicar el mismo patrón (o reintentos con
  conciliación) y documentarlo en la fase 1.

## Alternativas consideradas

- **Publicar después del commit, sin outbox:** simple, pero pierde eventos si el proceso cae.
- **CDC con Debezium:** elimina el polling, pero suma Kafka Connect y otro componente que
  operar.
- **Transacciones de Kafka (exactly-once):** no cubren la escritura en Postgres; igual hace
  falta idempotencia en el consumidor.
