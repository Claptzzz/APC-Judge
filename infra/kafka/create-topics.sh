#!/bin/bash
# Crea los topics del sistema y sus DLQ y les aplica su configuración. Idempotente, también
# sobre volúmenes existentes: si un topic ya existe, su configuración se aplica con
# `kafka-configs --alter` (crear con --if-not-exists no toca un topic que ya está).
# Mantener sincronizado con packages/contracts/src/topics.ts.
set -euo pipefail
rm -f /tmp/ready

BOOTSTRAP="${KAFKA_BOOTSTRAP:-kafka:29092}"
PARTITIONS="${KAFKA_TOPIC_PARTITIONS:-3}"
TOPICS=(user.registered submission.created submission.judged)
KT=/opt/kafka/bin/kafka-topics.sh
KC=/opt/kafka/bin/kafka-configs.sh

# Configuración por topic (solo el topic base; las DLQ quedan con la política por defecto,
# `delete`, para conservar todos los mensajes fallidos aunque compartan key).
# - user.registered: compactado. La key es el user_id, así que el log conserva el último
#   evento de cada usuario y ranking puede reconstruir los usernames desde el principio.
declare -A TOPIC_CONFIG=(
  [user.registered]="cleanup.policy=compact"
)

for topic in "${TOPICS[@]}"; do
  for name in "$topic" "$topic.dlq"; do
    config="${TOPIC_CONFIG[$name]:-}"
    create_args=(--bootstrap-server "$BOOTSTRAP" --create --if-not-exists
      --topic "$name" --partitions "$PARTITIONS" --replication-factor 1)
    [ -n "$config" ] && create_args+=(--config "$config")
    "$KT" "${create_args[@]}"

    # Para un topic que ya existía (volumen anterior), --create no cambia nada: se aplica
    # la configuración explícitamente. --add-config es idempotente.
    if [ -n "$config" ]; then
      "$KC" --bootstrap-server "$BOOTSTRAP" --alter \
        --entity-type topics --entity-name "$name" --add-config "$config"
    fi
  done
done

echo "Topics existentes:"
"$KT" --bootstrap-server "$BOOTSTRAP" --list

echo "Configuración aplicada:"
for name in "${!TOPIC_CONFIG[@]}"; do
  "$KC" --bootstrap-server "$BOOTSTRAP" --describe --entity-type topics --entity-name "$name"
done

# Marca de listo para el healthcheck y espera: así `docker compose up --wait`
# considera este contenedor healthy en vez de fallar porque terminó.
touch /tmp/ready
exec sleep infinity
