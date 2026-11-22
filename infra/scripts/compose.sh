#!/bin/sh
# Wrapper de docker compose para el stack local (infra + servicios con el profile `apps`).
# Usa .env de la raíz si existe; si no, .env.example (valores de desarrollo).
# Variables opcionales del shell:
#   JUEZ_ENV_FILE         otro archivo de variables (p. ej. para usar otros puertos en el host)
#   COMPOSE_PROJECT_NAME  otro nombre de proyecto (por defecto `juez`), p. ej. para levantar
#                         un segundo stack desde otro worktree junto con JUEZ_ENV_FILE
set -eu
ROOT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
if [ -n "${JUEZ_ENV_FILE:-}" ]; then
  [ -f "$JUEZ_ENV_FILE" ] || { echo "error: no existe JUEZ_ENV_FILE=$JUEZ_ENV_FILE" >&2; exit 1; }
  ENV_FILE="$JUEZ_ENV_FILE"
else
  ENV_FILE="$ROOT_DIR/.env"
  [ -f "$ENV_FILE" ] || ENV_FILE="$ROOT_DIR/.env.example"
fi
exec docker compose \
  --project-name "${COMPOSE_PROJECT_NAME:-juez}" \
  --env-file "$ENV_FILE" \
  --file "$ROOT_DIR/infra/docker-compose.yml" \
  "$@"
