#!/bin/sh
# Wrapper de docker compose para la infraestructura local.
# Usa .env de la raíz si existe; si no, .env.example (valores de desarrollo).
set -eu
ROOT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
ENV_FILE="$ROOT_DIR/.env"
[ -f "$ENV_FILE" ] || ENV_FILE="$ROOT_DIR/.env.example"
exec docker compose \
  --project-name juez \
  --env-file "$ENV_FILE" \
  --file "$ROOT_DIR/infra/docker-compose.yml" \
  "$@"
