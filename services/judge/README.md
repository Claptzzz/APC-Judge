# judge — worker de evaluación

|                     |                                                                                                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Paquete**         | `@juez/judge`                                                                                                                                                           |
| **Responsabilidad** | Consumir `submission.created`, compilar y ejecutar el código contra los casos de prueba en un sandbox y publicar el veredicto.                                          |
| **Framework**       | Worker Node **sin framework web**: `node:http` mínimo para `/health`, `/ready` y `/metrics`. Cliente gRPC Connect (`@connectrpc/connect-node`) hacia problems. kafkajs. |
| **Puertos**         | HTTP **8085** (solo health/readiness/métricas). Sin gRPC propio.                                                                                                        |
| **BD**              | Ninguna. Directorio temporal por submission bajo `JUDGE_WORKDIR`, que se borra siempre.                                                                                 |

## Endpoints HTTP

| Ruta       | Respuesta                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `/health`  | `200 {"status":"ok"}` mientras el proceso esté vivo.                                                                           |
| `/ready`   | `200` si el producer Kafka está conectado y el consumer está en el grupo (sin crash); si no, `503` con el detalle de `checks`. |
| `/metrics` | Texto Prometheus: `judge_submissions_judged_total{verdict}`, `judge_dlq_messages_total`, `judge_submission_duration_seconds`.  |

problems no forma parte de `/ready`: si no responde, cada submission termina en `INTERNAL_ERROR`
(después de reintentos), pero el worker sigue consumiendo.

## Procesamiento

- Consume `submission.created` con el group `JUDGE_KAFKA_GROUP_ID`, **un mensaje a la vez por
  instancia** (`partitionsConsumedConcurrently: 1`). Se escala con réplicas, hasta el número de
  particiones (3). Un group nuevo empieza desde el principio del topic.
- **Commit manual** (`autoCommit: false`): el offset se confirma solo después de publicar
  `submission.judged` (_at-least-once_). Si publicar falla, el handler lanza el error y kafkajs
  reintenta el mismo mensaje.
- Mientras evalúa, envía heartbeats al grupo cada 3 s para no perder la partición en
  submissions largas.
- Por cada submission:
  1. `GetJudgeSpec(problem_id)` con timeout de 5 s y hasta 4 intentos (backoff exponencial) en
     errores transitorios (`UNAVAILABLE`, `DEADLINE_EXCEEDED`, `RESOURCE_EXHAUSTED`, `ABORTED`,
     `INTERNAL`, `UNKNOWN`). Propaga `x-request-id` (header del mensaje si viene; si no, el
     `event_id` de `submission.created`).
  2. Descarga input y output de cada caso con las URLs prefirmadas a
     `JUDGE_WORKDIR/sub-XXXX/cases/` (3 intentos; un 4xx distinto de 408/429 no se reintenta).
  3. Compila en `JUDGE_WORKDIR/sub-XXXX/box/` con timeout `JUDGE_COMPILE_TIMEOUT_MS`:
     - `LANGUAGE_CPP17`: `g++ -O2 -std=gnu++17 -o main main.cpp`.
     - `LANGUAGE_PYTHON3`: sin compilación; solo valida la sintaxis con
       `python3 -m py_compile main.py`. Se ejecuta con `python3 main.py`.
  4. Ejecuta los casos en orden de `ordinal` **hasta el primer fallo**.
  5. Publica `submission.judged` y hace commit.
- Un mensaje que no se puede deserializar (o sin `submission_id`) se reenvía tal cual a
  `submission.created.dlq` con headers `x-dlq-reason`, `x-dlq-error`, `x-original-topic`,
  `x-original-partition` y `x-original-offset`, y se hace commit.

## Sandbox

Cada ejecución (compilación incluida) corre como subproceso en su **propio grupo de procesos**,
con un entorno mínimo (`PATH`, `LANG`, `HOME`) y esta cadena:

```
unshare -rn -- /usr/bin/time -f %M -o <tmp>/time.txt prlimit --core=0 --as=… --cpu=… --fsize=… -- <programa>
```

| Límite          | Cómo                                                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Tiempo de pared | Timer en Node con `time_limit_ms`; al vencer se mata el grupo con `SIGKILL`.                                                  |
| CPU (respaldo)  | `prlimit --cpu=ceil(time_limit_ms/1000)+1` (`SIGXCPU` cuenta como TLE).                                                       |
| Memoria         | `prlimit --as=memory_limit_mb` (espacio de direcciones).                                                                      |
| Salida          | stdout se corta en `JUDGE_MAX_OUTPUT_KB` y se mata el grupo; `prlimit --fsize` acota los archivos que escriba el programa.    |
| Red             | `unshare -rn`: namespace de usuario + red sin interfaces. Si no está disponible, ver [limitaciones](#limitaciones-conocidas). |
| Core dumps      | `prlimit --core=0`.                                                                                                           |

**Mediciones:** el tiempo es el de pared medido por Node (`time_ms` reporta el máximo de los
casos ejecutados, acotado al límite). La memoria es el RSS máximo que reporta GNU time (`%M`,
en KB); `memory_kb` es el máximo de los casos. Si GNU time no existe, `memory_kb` es 0.

Al arrancar se detecta qué herramientas hay: `prlimit` es obligatorio (sin él el proceso no
arranca); si `unshare -rn` falla o falta `/usr/bin/time`, se registra un **warning** y se sigue.

### Veredictos

Para cada caso, en este orden:

| Veredicto               | Condición                                                                                                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TIME_LIMIT_EXCEEDED`   | Se venció el tiempo de pared, el tiempo medido supera `time_limit_ms` o el proceso murió por `SIGXCPU`.                                                                                      |
| `RUNTIME_ERROR`         | La salida superó `JUDGE_MAX_OUTPUT_KB` (no existe un veredicto de _output limit_ en el contrato).                                                                                            |
| `MEMORY_LIMIT_EXCEEDED` | RSS máximo > `memory_limit_mb`, o el proceso falló con un error de asignación (`std::bad_alloc`, `MemoryError`, `Cannot allocate memory`). Con `--as` la falta de memoria se manifiesta así. |
| `RUNTIME_ERROR`         | Código de salida ≠ 0 o muerte por señal.                                                                                                                                                     |
| `WRONG_ANSWER`          | La salida no coincide por tokens (separados por cualquier espacio en blanco ASCII; cada token se compara byte a byte).                                                                       |
| `ACCEPTED`              | Todos los casos coinciden.                                                                                                                                                                   |

Además: `COMPILATION_ERROR` si la compilación (o `py_compile`) falla o excede
`JUDGE_COMPILE_TIMEOUT_MS`, o si el lenguaje no está soportado. `INTERNAL_ERROR` si falla algo
del juez: problems no responde tras los reintentos, el problema no tiene casos o límites, falla
la descarga, o no se puede lanzar el compilador/runtime.

## RPCs que expone

Ninguno.

## RPCs que consume

| Servicio | RPC            | Para qué                                                                                            |
| -------- | -------------- | --------------------------------------------------------------------------------------------------- |
| problems | `GetJudgeSpec` | Límites + URLs prefirmadas (GET) de input/output de cada caso. Llamada interna, sin JWT de usuario. |

## Eventos

|         | Topic                    | Key             | Detalle                                                                                                                           |
| ------- | ------------------------ | --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Consume | `submission.created`     |                 | Group `JUDGE_KAFKA_GROUP_ID`. Un mensaje a la vez por instancia; commit manual tras publicar el veredicto.                        |
| Publica | `submission.judged`      | `submission_id` | Un evento por submission con veredicto final (incluido `INTERNAL_ERROR`). `submitted_at` = `occurred_at` de `submission.created`. |
| Publica | `submission.created.dlq` | la original     | Mensajes que no se pueden deserializar, con headers de error.                                                                     |

**Idempotencia:** el judge no guarda estado. Si procesa dos veces la misma submission
(_at-least-once_), publica un `SubmissionJudged` con el **mismo `event_id`**: UUID v5 del
`submission_id` con el namespace fijo `fc973b7e-d0c6-4f79-bc69-56e763b304cd`
(`src/event-id.ts`). Se pasa explícitamente a `encodeEvent`.

## Variables de entorno

| Variable                                                           | Ejemplo                                                                                      |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `JUDGE_HTTP_PORT`                                                  | `8085`                                                                                       |
| `KAFKA_BROKERS` · `JUDGE_KAFKA_CLIENT_ID` · `JUDGE_KAFKA_GROUP_ID` | `localhost:9092` · `judge` · `judge`                                                         |
| `PROBLEMS_GRPC_ADDR`                                               | `localhost:50052` (Connect: `http://localhost:50052`)                                        |
| `JUDGE_CONCURRENCY`                                                | `2` — se valida pero **se ignora** (warning al arrancar): un mensaje a la vez por instancia. |
| `JUDGE_WORKDIR`                                                    | `/tmp/juez-judge`                                                                            |
| `JUDGE_COMPILE_TIMEOUT_MS` · `JUDGE_MAX_OUTPUT_KB`                 | `10000` · `65536`                                                                            |
| `LOG_LEVEL`                                                        | `info`                                                                                       |

`KAFKA_BROKERS` y `PROBLEMS_GRPC_ADDR` son obligatorias; el resto toma el valor del ejemplo.
Se validan con zod al arrancar. `PROBLEMS_GRPC_ADDR` acepta `host:port` o una URL.

## Limitaciones conocidas

- **Red en Docker:** el perfil seccomp por defecto de Docker bloquea `unshare` con
  `CLONE_NEWUSER`, así que en un contenedor normal el judge arranca con el warning
  _"unshare -rn no está disponible"_ y **los programas tienen acceso a la red**. En particular
  podrían llamar a `GetJudgeSpec` (que no exige JWT) y leer las salidas esperadas. Para aislar
  la red: correr el contenedor con un perfil seccomp que permita `unshare`/`clone` con
  namespaces de usuario (verificado con `--security-opt seccomp=unconfined`) o, en Kubernetes,
  aplicar una `NetworkPolicy` de egress para el pod del judge que solo permita Kafka, problems y
  MinIO. Lo mismo ocurre en hosts con AppArmor que restringe los user namespaces sin
  privilegios (p. ej. Ubuntu ≥ 23.10; puede afectar a los runners de GitHub).
- **Mismo usuario que el judge:** el programa corre con el uid del worker (no-root en la
  imagen). Puede leer archivos legibles por ese usuario, incluidos los casos descargados de su
  propia submission. Un aislamiento completo (uid aparte, mount namespace, cgroups) queda para
  una herramienta dedicada (p. ej. nsjail o isolate).
- **Memoria por `--as`:** limita espacio de direcciones, no RSS. Programas que reservan
  memoria virtual sin usarla pueden fallar antes del límite real; el RSS se mide aparte.
- **Fork bombs:** no se limita el número de procesos (`RLIMIT_NPROC` es por uid y afectaría al
  propio worker); el timer de pared mata el grupo, pero un proceso que haga `setsid` escapa de él.
- kafkajs 2.2.4 emite un `TimeoutNegativeWarning` en Node ≥ 23 al arrancar; es inofensivo.

## Desarrollo

```sh
pnpm --filter @juez/judge test        # Vitest + cobertura (compila y ejecuta C++ y Python reales)
pnpm --filter @juez/judge build
pnpm --filter @juez/judge start:local # usa .env.example/.env de la raíz (requiere pnpm infra:up)

docker build -f services/judge/Dockerfile -t juez-judge .   # contexto = raíz del repo
```

Los tests requieren `g++`, `python3` y `prlimit`; `unshare -rn` y GNU time son opcionales (los
tests que dependen de ellos se adaptan). La imagen se basa en `node:26-trixie-slim` con `g++`,
`python3`, `time` y `util-linux`, y corre como el usuario `node` (uid 1000).
