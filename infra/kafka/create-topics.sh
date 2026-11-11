#!/bin/bash
# Crea los topics del sistema y sus DLQ (idempotente). Mantener sincronizado con
# packages/contracts/src/topics.ts.
set -euo pipefail
rm -f /tmp/ready

BOOTSTRAP="${KAFKA_BOOTSTRAP:-kafka:29092}"
PARTITIONS="${KAFKA_TOPIC_PARTITIONS:-3}"
TOPICS=(user.registered submission.created submission.judged)
KT=/opt/kafka/bin/kafka-topics.sh

for topic in "${TOPICS[@]}"; do
  for name in "$topic" "$topic.dlq"; do
    "$KT" --bootstrap-server "$BOOTSTRAP" --create --if-not-exists \
      --topic "$name" --partitions "$PARTITIONS" --replication-factor 1
  done
done

echo "Topics existentes:"
"$KT" --bootstrap-server "$BOOTSTRAP" --list

# Marca de listo para el healthcheck y espera: así `docker compose up --wait`
# considera este contenedor healthy en vez de fallar porque terminó.
touch /tmp/ready
exec sleep infinity
