# judge — worker de evaluación

|                     |                                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Paquete**         | `@juez/judge`                                                                                                                                                 |
| **Responsabilidad** | Consumir `submission.created`, compilar y ejecutar el código contra los casos de prueba en un sandbox y publicar el veredicto.                                |
| **Framework**       | Worker Node **sin framework web**: `node:http` mínimo para `/health` y `/metrics`. Cliente gRPC Connect (`@connectrpc/connect-node`) hacia problems. kafkajs. |
| **Puertos**         | HTTP **8085** (solo health/métricas). Sin gRPC propio.                                                                                                        |
| **BD**              | Ninguna. Caché local opcional de casos de prueba en `JUDGE_WORKDIR`.                                                                                          |

## Sandbox

Cada ejecución corre en un subproceso con límites de tiempo (wall + CPU), memoria y tamaño de
salida, **sin red** y en un directorio temporal propio que se borra al terminar. Lenguajes:
`LANGUAGE_CPP17` (compilar con `g++ -std=c++17 -O2`) y `LANGUAGE_PYTHON3`. La herramienta
concreta de aislamiento se define en la fase 1 y se documenta en un ADR.

## RPCs que expone

Ninguno.

## RPCs que consume

| Servicio | RPC            | Para qué                                                                                            |
| -------- | -------------- | --------------------------------------------------------------------------------------------------- |
| problems | `GetJudgeSpec` | Límites + URLs prefirmadas (GET) de input/output de cada caso. Llamada interna, sin JWT de usuario. |

## Eventos

|         | Topic                | Key             | Detalle                                                                                                                                          |
| ------- | -------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Consume | `submission.created` |                 | Group `JUDGE_KAFKA_GROUP_ID`. Concurrencia `JUDGE_CONCURRENCY`. Tras N reintentos por error de infraestructura envía a `submission.created.dlq`. |
| Publica | `submission.judged`  | `submission_id` | Un evento por submission con veredicto final (incluido `INTERNAL_ERROR`).                                                                        |

**Idempotencia:** el judge no guarda estado. Si procesa dos veces la misma submission
(_at-least-once_), publica un `SubmissionJudged` con el **mismo `event_id`**, derivado de
forma determinista del `submission_id` (p. ej. UUID v5), para que los consumidores
deduplicen. Se pasa explícitamente a `encodeEvent`.

## Variables de entorno

| Variable                                                           | Ejemplo                                               |
| ------------------------------------------------------------------ | ----------------------------------------------------- |
| `JUDGE_HTTP_PORT`                                                  | `8085`                                                |
| `KAFKA_BROKERS` · `JUDGE_KAFKA_CLIENT_ID` · `JUDGE_KAFKA_GROUP_ID` | `localhost:9092` · `judge` · `judge`                  |
| `PROBLEMS_GRPC_ADDR`                                               | `localhost:50052` (Connect: `http://localhost:50052`) |
| `JUDGE_CONCURRENCY`                                                | `2`                                                   |
| `JUDGE_WORKDIR`                                                    | `/tmp/juez-judge`                                     |
| `JUDGE_COMPILE_TIMEOUT_MS` · `JUDGE_MAX_OUTPUT_KB`                 | `10000` · `65536`                                     |
| `LOG_LEVEL`                                                        | `info`                                                |
