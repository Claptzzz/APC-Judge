# ADR 0003 — Kafka + protobuf para eventos

- **Estado:** Aceptada
- **Fecha:** 2026-11-10

## Contexto

Evaluar una submission es lento (compilación y ejecución) y sus resultados interesan a varios
componentes (submissions, ranking, bff). Acoplarlos con llamadas síncronas haría que la caída
de uno bloquee a los demás. Además, los eventos son contratos entre equipos y deben
evolucionar sin romper a los consumidores.

## Decisión

- Comunicación asíncrona por **Apache Kafka** (KRaft; un nodo en local).
- Topics: `user.registered`, `submission.created`, `submission.judged`, con **3 particiones**
  cada uno y su DLQ `<topic>.dlq`. Sin auto-creación: los crea `kafka-init`.
- **Valor del mensaje: protobuf binario** de `juez.events.v1.*`. **Key: id del agregado**
  (`user_id` o `submission_id`), lo que garantiza orden por agregado dentro de la partición.
- Cada evento lleva `event_id` (UUID) y `occurred_at`. Headers informativos:
  `content-type: application/x-protobuf`, `event-type: <typeName>` y `event-id`.
- `@juez/contracts` exporta las constantes de topics y `encodeEvent` / `decodeEvent`
  (protobuf-es v2), para que nadie serialice a mano.
- Cliente `kafkajs` en todos los servicios.

## Consecuencias

- Productores y consumidores se despliegan y escalan por separado; un consumidor caído
  procesa lo pendiente al volver.
- La compatibilidad del esquema la garantiza `buf breaking` (regla FILE) en CI: los campos se
  agregan con números nuevos y nunca se reutilizan.
- Los mensajes no se leen como texto en Kafka UI sin el descriptor; los headers ayudan a
  identificarlos.
- Entrega _at-least-once_: obliga a consumidores idempotentes ([ADR 0004](0004-outbox-consumidores-idempotentes.md)).
- Sin Schema Registry: el esquema viaja en el código (`@juez/contracts`). Aceptable con un
  monorepo; habría que reconsiderarlo con productores externos.

## Alternativas consideradas

- **JSON:** legible, pero sin contrato verificable ni chequeo de compatibilidad, y más pesado.
- **RabbitMQ / NATS:** buenos para colas de trabajo, pero el log reproducible con consumer
  groups independientes de Kafka encaja mejor con varios consumidores del mismo evento.
- **Avro + Schema Registry:** robusto, pero suma un componente y un segundo IDL; ya usamos
  protobuf para gRPC.
