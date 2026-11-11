#!/bin/sh
# Init de Postgres (solo corre con el volumen vacío): una BD y un usuario por servicio.
# Cada usuario es dueño de su BD y no puede conectarse a las de los demás.
set -eu

create_service_db() {
  db="$1"; user="$2"; password="$3"
  echo "init: BD '$db' con usuario '$user'"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
    -v db="$db" -v usr="$user" -v pwd="$password" <<'SQL'
CREATE ROLE :"usr" LOGIN PASSWORD :'pwd';
CREATE DATABASE :"db" OWNER :"usr";
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT ALL PRIVILEGES ON DATABASE :"db" TO :"usr";
SQL
  # Desde PG 15 el schema public pertenece a pg_database_owner (= el dueño de la BD).
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" \
    -c "REVOKE ALL ON SCHEMA public FROM PUBLIC;"
}

create_service_db "$USERS_DB_NAME" "$USERS_DB_USER" "$USERS_DB_PASSWORD"
create_service_db "$PROBLEMS_DB_NAME" "$PROBLEMS_DB_USER" "$PROBLEMS_DB_PASSWORD"
create_service_db "$SUBMISSIONS_DB_NAME" "$SUBMISSIONS_DB_USER" "$SUBMISSIONS_DB_PASSWORD"
create_service_db "$RANKING_DB_NAME" "$RANKING_DB_USER" "$RANKING_DB_PASSWORD"

# Las BD por defecto tampoco son accesibles para los usuarios de servicio.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -c "REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;" \
  -c "REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;"
