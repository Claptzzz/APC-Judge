#!/bin/sh
# Prueba de humo del backend contra el stack de docker (`pnpm stack:up` + `pnpm stack:seed`).
# Usa `buf curl` (gRPC sobre HTTP/2 sin TLS) contra los puertos gRPC publicados en el host:
#   1. Registra un usuario nuevo y hace login.
#   2. Lista los problemas sembrados y busca A + B (`a-mas-b`).
#   3. Envía una solución correcta en C++ y una incorrecta en Python.
#   4. Espera los veredictos con GetSubmission: ACCEPTED y WRONG_ANSWER.
#   5. Con el admin inicial crea un contest con A + B, envía una submission dentro del contest
#      y espera a que el usuario aparezca en GetScoreboard.
# Termina con código ≠ 0 si algo falla. Se puede correr varias veces (usuario y contest nuevos).
# Puertos y credenciales del admin: variables del shell, si no .env (o JUEZ_ENV_FILE), si no
# .env.example.
# Uso: pnpm stack:smoke   (SMOKE_TIMEOUT_S=180 para esperar más los veredictos)
set -eu

ROOT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT_DIR"

if [ -n "${JUEZ_ENV_FILE:-}" ]; then
  ENV_FILE="$JUEZ_ENV_FILE"
else
  ENV_FILE="$ROOT_DIR/.env"
  [ -f "$ENV_FILE" ] || ENV_FILE="$ROOT_DIR/.env.example"
fi

# Valor de una variable: el shell primero, luego el archivo de entorno, luego el default.
env_get() {
  eval "current=\${$1:-}"
  if [ -n "$current" ]; then
    printf '%s' "$current"
    return
  fi
  from_file=$(sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | tail -n 1)
  printf '%s' "${from_file:-$2}"
}

USERS_ADDR="http://localhost:$(env_get USERS_GRPC_PORT 50051)"
PROBLEMS_ADDR="http://localhost:$(env_get PROBLEMS_GRPC_PORT 50052)"
SUBMISSIONS_ADDR="http://localhost:$(env_get SUBMISSIONS_GRPC_PORT 50053)"
RANKING_ADDR="http://localhost:$(env_get RANKING_GRPC_PORT 50054)"
ADMIN_USERNAME=$(env_get USERS_ADMIN_USERNAME admin)
ADMIN_PASSWORD=$(env_get USERS_ADMIN_PASSWORD admin_dev_password)
TIMEOUT_S="${SMOKE_TIMEOUT_S:-120}"

BUF="$ROOT_DIR/node_modules/.bin/buf"
[ -x "$BUF" ] || BUF=buf
command -v "$BUF" >/dev/null 2>&1 || {
  echo "error: no se encontró buf (pnpm install)" >&2
  exit 1
}
command -v node >/dev/null 2>&1 || {
  echo "error: se requiere node" >&2
  exit 1
}

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT INT TERM

step() { printf '\n==> %s\n' "$*"; }
ok() { printf '    ok: %s\n' "$*"; }
fail() {
  printf '\nSMOKE FALLÓ: %s\n' "$*" >&2
  exit 1
}

# El schema se compila una vez (buf curl lo usa en vez de reflection).
SCHEMA="$WORK_DIR/schema.binpb"
"$BUF" build -o "$SCHEMA" || fail "buf build"

# rpc <url> <json> [token]: llama por gRPC e imprime la respuesta JSON. Si falla, muestra el
# error de buf curl en stderr y no imprime nada (el `json` que sigue en el pipe falla).
rpc() {
  rpc_url="$1"
  rpc_data="$2"
  rpc_token="${3:-}"
  if [ -n "$rpc_token" ]; then
    set -- -H "authorization: Bearer $rpc_token"
  else
    set --
  fi
  if "$BUF" curl --schema "$SCHEMA" --protocol grpc --http2-prior-knowledge --timeout 15s \
    "$@" -d "$rpc_data" "$rpc_url" >"$WORK_DIR/out" 2>"$WORK_DIR/err"; then
    cat "$WORK_DIR/out"
  else
    printf '    error en %s: %s\n' "${rpc_url##*/}" "$(cat "$WORK_DIR/err")" >&2
    return 1
  fi
}

# json <expresión JS sobre `r`>: evalúa sobre el JSON de stdin; sale ≠ 0 si da undefined/null.
json() {
  node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const r = s.trim() ? JSON.parse(s) : {};
      const v = new Function("r", "return (" + process.argv[1] + ");")(r);
      if (v === undefined || v === null) process.exit(1);
      process.stdout.write(typeof v === "object" ? JSON.stringify(v) : String(v));
    });
  ' "$1"
}

# body <expresión JS>: imprime el JSON de un objeto (escapa el código fuente). Lee las
# variables SMOKE_* exportadas con process.env.
body() { node -e 'process.stdout.write(JSON.stringify(new Function("return (" + process.argv[1] + ");")()))' "$1"; }

# expect_verdict <submission_id> <token> <veredicto>: espera un veredicto final (GetSubmission
# cada 1 s, hasta TIMEOUT_S) y falla si no es el esperado.
expect_verdict() {
  deadline=$(($(date +%s) + TIMEOUT_S))
  while :; do
    verdict=$(rpc "$SUBMISSIONS_ADDR/juez.submissions.v1.SubmissionService/GetSubmission" \
      "{\"id\":\"$1\"}" "$2" | json 'r.submission.verdict') || verdict=""
    case "$verdict" in
      "" | VERDICT_PENDING | VERDICT_JUDGING) ;;
      *) break ;;
    esac
    [ "$(date +%s)" -lt "$deadline" ] ||
      fail "la submission $1 sigue sin veredicto tras ${TIMEOUT_S}s (último: ${verdict:-PENDING})"
    sleep 1
  done
  [ "$verdict" = "$3" ] || fail "submission $1: veredicto $verdict, se esperaba $3"
  ok "submission $1 → $verdict"
}

# Las soluciones y los ids van por variables de entorno a `body`/`json` (sin escapar a mano).
SMOKE_CPP_OK='#include <iostream>
int main() { long long a, b; std::cin >> a >> b; std::cout << a + b << "\n"; return 0; }
'
SMOKE_PY_WA='a, b = map(int, input().split())
print(a + b + 1)
'
export SMOKE_CPP_OK SMOKE_PY_WA

# --- 1. Registro y login ------------------------------------------------------------------
SUFFIX="$(date +%s)$$"
USERNAME="smoke_$SUFFIX"
PASSWORD="smoke_password_$SUFFIX"
step "1. Registro y login de $USERNAME"
USER_ID=$(rpc "$USERS_ADDR/juez.users.v1.UserService/Register" \
  "{\"username\":\"$USERNAME\",\"email\":\"$USERNAME@example.com\",\"password\":\"$PASSWORD\"}" |
  json 'r.user.id') || fail "Register no devolvió user.id"
ok "usuario $USER_ID"
TOKEN=$(rpc "$USERS_ADDR/juez.users.v1.UserService/Login" \
  "{\"usernameOrEmail\":\"$USERNAME\",\"password\":\"$PASSWORD\"}" |
  json 'r.accessToken') || fail "Login no devolvió access_token"
ok "login (JWT de ${#TOKEN} caracteres)"

# --- 2. Problemas sembrados ---------------------------------------------------------------
step "2. Problemas sembrados"
PROBLEMS=$(rpc "$PROBLEMS_ADDR/juez.problems.v1.ProblemService/ListProblems" '{"pageSize":100}' "$TOKEN")
printf '%s' "$PROBLEMS" | json '(r.problems || []).map((p) => p.slug).join(", ") || undefined' >/dev/null ||
  fail "ListProblems no devolvió problemas (¿corriste pnpm stack:seed?)"
ok "$(printf '%s' "$PROBLEMS" | json '(r.problems || []).map((p) => p.slug).join(", ")')"
PROBLEM_ID=$(printf '%s' "$PROBLEMS" | json '(r.problems || []).find((p) => p.slug === "a-mas-b")?.id') ||
  fail "no está el problema a-mas-b (¿corriste pnpm stack:seed?)"
ok "a-mas-b = $PROBLEM_ID"
export SMOKE_PROBLEM_ID="$PROBLEM_ID"

# --- 3 y 4. Submissions y veredictos ------------------------------------------------------
step "3. Submissions a A + B (C++ correcta, Python incorrecta)"
CPP_ID=$(rpc "$SUBMISSIONS_ADDR/juez.submissions.v1.SubmissionService/CreateSubmission" \
  "$(body '{ problemId: process.env.SMOKE_PROBLEM_ID, language: "LANGUAGE_CPP17", sourceCode: process.env.SMOKE_CPP_OK }')" \
  "$TOKEN" | json 'r.submission.id') || fail "CreateSubmission (C++) no devolvió id"
ok "C++ $CPP_ID"
PY_ID=$(rpc "$SUBMISSIONS_ADDR/juez.submissions.v1.SubmissionService/CreateSubmission" \
  "$(body '{ problemId: process.env.SMOKE_PROBLEM_ID, language: "LANGUAGE_PYTHON3", sourceCode: process.env.SMOKE_PY_WA }')" \
  "$TOKEN" | json 'r.submission.id') || fail "CreateSubmission (Python) no devolvió id"
ok "Python $PY_ID"

step "4. Veredictos (GetSubmission, hasta ${TIMEOUT_S}s)"
expect_verdict "$CPP_ID" "$TOKEN" VERDICT_ACCEPTED
expect_verdict "$PY_ID" "$TOKEN" VERDICT_WRONG_ANSWER

# --- 5. Contest y scoreboard --------------------------------------------------------------
step "5. Contest con A + B y scoreboard"
export SMOKE_ADMIN_USERNAME="$ADMIN_USERNAME" SMOKE_ADMIN_PASSWORD="$ADMIN_PASSWORD"
export SMOKE_CONTEST_TITLE="Smoke $SUFFIX"
ADMIN_TOKEN=$(rpc "$USERS_ADDR/juez.users.v1.UserService/Login" \
  "$(body '{ usernameOrEmail: process.env.SMOKE_ADMIN_USERNAME, password: process.env.SMOKE_ADMIN_PASSWORD }')" |
  json 'r.accessToken') || fail "login del admin ($ADMIN_USERNAME)"
CONTEST_ID=$(rpc "$RANKING_ADDR/juez.ranking.v1.RankingService/CreateContest" \
  "$(body '{
    title: process.env.SMOKE_CONTEST_TITLE,
    description: "Creado por infra/scripts/smoke-backend.sh",
    startTime: new Date(Date.now() - 60_000).toISOString(),
    endTime: new Date(Date.now() + 3_600_000).toISOString(),
    problemIds: [process.env.SMOKE_PROBLEM_ID],
  }')" "$ADMIN_TOKEN" | json 'r.contest.id') || fail "CreateContest no devolvió id"
ok "contest $CONTEST_ID"
export SMOKE_CONTEST_ID="$CONTEST_ID" SMOKE_USER_ID="$USER_ID"

CONTEST_SUB_ID=$(rpc "$SUBMISSIONS_ADDR/juez.submissions.v1.SubmissionService/CreateSubmission" \
  "$(body '{ problemId: process.env.SMOKE_PROBLEM_ID, contestId: process.env.SMOKE_CONTEST_ID, language: "LANGUAGE_CPP17", sourceCode: process.env.SMOKE_CPP_OK }')" \
  "$TOKEN" | json 'r.submission.id') || fail "CreateSubmission en el contest no devolvió id"
ok "submission en el contest $CONTEST_SUB_ID"
expect_verdict "$CONTEST_SUB_ID" "$TOKEN" VERDICT_ACCEPTED

deadline=$(($(date +%s) + 30))
while :; do
  ROW=$(rpc "$RANKING_ADDR/juez.ranking.v1.RankingService/GetScoreboard" \
    "{\"contestId\":\"$CONTEST_ID\"}" "$TOKEN" |
    json '(r.rows || []).find((x) => x.userId === process.env.SMOKE_USER_ID)') || ROW=""
  [ -n "$ROW" ] && break
  [ "$(date +%s)" -lt "$deadline" ] || fail "el usuario $USER_ID no aparece en el scoreboard del contest $CONTEST_ID"
  sleep 1
done
SOLVED=$(printf '%s' "$ROW" | json 'r.solved ?? 0')
[ "$SOLVED" = 1 ] || fail "scoreboard: solved=$SOLVED, se esperaba 1 (fila: $ROW)"
ok "scoreboard: $(printf '%s' "$ROW" | json '`rank ${r.rank}, ${r.username}, ${r.solved} resuelto(s), penalización ${r.penaltyMinutes ?? 0} min`')"

printf '\nSMOKE OK\n'
