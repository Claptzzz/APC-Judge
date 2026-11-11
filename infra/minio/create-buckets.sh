#!/bin/sh
# Crea el bucket de casos de prueba (idempotente). Privado: el acceso es por URLs prefirmadas.
set -eu
rm -f /tmp/ready
mc alias set local "http://minio:9000" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
mc mb --ignore-existing "local/$S3_BUCKET_TESTCASES"
mc anonymous set none "local/$S3_BUCKET_TESTCASES"
mc ls local

# Marca de listo para el healthcheck (ver infra/kafka/create-topics.sh).
touch /tmp/ready
exec sleep infinity
