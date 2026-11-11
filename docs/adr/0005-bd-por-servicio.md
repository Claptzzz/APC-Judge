# ADR 0005 — Base de datos por servicio

- **Estado:** Aceptada
- **Fecha:** 2026-11-10

## Contexto

Si los servicios comparten tablas, quedan acoplados por el esquema: un cambio en uno rompe a
otro y se pierde la autonomía de despliegue. A la vez, levantar cuatro instancias de Postgres
en cada laptop es caro.

## Decisión

- Cada servicio es **dueño exclusivo** de sus datos; nadie más los lee ni los escribe. Los
  datos de otro servicio se obtienen por gRPC o se proyectan a partir de eventos (p. ej.
  ranking guarda `user_id → username` desde `user.registered`).
- Postgres para users, problems, submissions y ranking (contests); Redis para el scoreboard de
  ranking; MinIO para los archivos de casos de prueba de problems.
- **En local:** una sola instancia de Postgres con **una BD y un usuario por servicio**
  (`users`/`users_svc`, …). Cada usuario es dueño de su BD; se revoca `CONNECT` a `PUBLIC`,
  así que ningún usuario puede conectarse a la BD de otro (`infra/postgres/init-databases.sh`).
- **En Kubernetes:** una instancia (o cluster gestionado) separada por servicio, con
  credenciales en Secrets propios. El código no cambia: solo `*_DATABASE_URL`.
- Cada servicio gestiona sus migraciones.

## Consecuencias

- Los servicios evolucionan su esquema sin coordinarse.
- Los permisos garantizan el aislamiento también en local, aunque la instancia sea compartida.
- No hay joins entre servicios: se resuelven con llamadas batch (`GetUsers`) o con
  proyecciones locales, aceptando consistencia eventual.
- En local, la instancia compartida es un punto único de falla y comparte recursos; no sirve
  para medir rendimiento por servicio.

## Alternativas consideradas

- **BD compartida con schemas por servicio:** más barato, pero el aislamiento depende de la
  disciplina.
- **Una instancia por servicio también en local:** fiel a producción, pero más pesado sin
  aportar al desarrollo diario.
