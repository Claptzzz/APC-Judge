#!/bin/sh
# Genera un par de llaves RS256 de DESARROLLO en .secrets/ (gitignored).
#   .secrets/jwt-private.pem  (PKCS#8) -> solo la usa users para firmar
#   .secrets/jwt-public.pem   (SPKI)   -> users la expone vía GetPublicKey
# Uso: sh infra/scripts/gen-jwt-keys.sh [--force]
set -eu
ROOT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
SECRETS_DIR="$ROOT_DIR/.secrets"
PRIVATE_KEY="$SECRETS_DIR/jwt-private.pem"
PUBLIC_KEY="$SECRETS_DIR/jwt-public.pem"

if ! command -v openssl >/dev/null 2>&1; then
  echo "error: se requiere openssl" >&2
  exit 1
fi

if [ -f "$PRIVATE_KEY" ] && [ "${1:-}" != "--force" ]; then
  echo "Ya existen llaves en $SECRETS_DIR (usa --force para regenerarlas)."
  exit 0
fi

mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"
umask 077
# -quiet existe en OpenSSL 3; LibreSSL (macOS) no lo soporta.
QUIET=""
if openssl genpkey -help 2>&1 | grep -q -- '-quiet'; then QUIET="-quiet"; fi
# shellcheck disable=SC2086
openssl genpkey $QUIET -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$PRIVATE_KEY"
openssl pkey -in "$PRIVATE_KEY" -pubout -out "$PUBLIC_KEY"
chmod 600 "$PRIVATE_KEY"
chmod 644 "$PUBLIC_KEY"
echo "Llaves RS256 generadas:"
echo "  privada: $PRIVATE_KEY"
echo "  pública: $PUBLIC_KEY"
