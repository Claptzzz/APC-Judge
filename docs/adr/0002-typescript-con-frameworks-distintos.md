# ADR 0002 — TypeScript en todo, con un framework distinto por servicio

- **Estado:** Aceptada
- **Fecha:** 2026-11-10

## Contexto

El objetivo del taller es practicar arquitectura de microservicios, incluida su
heterogeneidad. Un solo lenguaje reduce la fricción (tooling, tests, contratos generados una
vez), pero si todos los servicios usan el mismo framework se pierde la experiencia de
integrar stacks distintos detrás de contratos comunes.

## Decisión

Todo en **TypeScript sobre Node LTS**, con un framework distinto por componente:

| Componente  | Framework                        | gRPC                             |
| ----------- | -------------------------------- | -------------------------------- |
| web         | React + Vite + Apollo Client     | —                                |
| bff         | NestJS + Apollo GraphQL          | cliente `@grpc/grpc-js` (Nest)   |
| users       | Fastify                          | servidor Connect (HTTP/2 aparte) |
| problems    | Express                          | servidor Connect (HTTP/2 aparte) |
| submissions | NestJS híbrido                   | servidor `@grpc/grpc-js` (Nest)  |
| ranking     | Hono                             | servidor Connect (HTTP/2 aparte) |
| judge       | Node sin framework (`node:http`) | cliente Connect                  |
| mcp         | MCP TypeScript SDK               | cliente Connect                  |

- Los servicios que no son Nest sirven gRPC con `@connectrpc/connect-node` en un **servidor
  HTTP/2 separado** del framework web, porque los clientes `@grpc/grpc-js` requieren HTTP/2.
  El framework web atiende `/health` y `/metrics`.
- Nest carga los `.proto` en runtime con `@grpc/proto-loader` y usa los tipos de ts-proto
  (`@juez/contracts/nest`); el resto usa protobuf-es v2 (`@juez/contracts/es`).
- `kafkajs` como cliente Kafka en todos (el mismo que usa `@nestjs/microservices`).
- Calidad común: ESLint flat config, Prettier y Vitest con cobertura ≥ 60 % desde `@juez/config`.

## Consecuencias

- Se ejercita la interoperabilidad real: grpc-js ↔ Connect y dos generadores de código
  sobre los mismos `.proto`.
- Hay dos representaciones TS de los mismos mensajes (protobuf-es y ts-proto) con
  diferencias (p. ej. los enums: `Verdict.ACCEPTED` en es, `Verdict.VERDICT_ACCEPTED` en
  ts-proto). Cada servicio usa una sola.
- Mantener varios frameworks cuesta más que uno; se mitiga con configuración compartida y
  convenciones comunes de health, puertos y variables de entorno.
- TypeScript queda fijado en 6.0.x: TypeScript 7 (nativo) todavía no lo soporta
  `typescript-eslint` (peer `<6.1.0`).

## Alternativas consideradas

- **Un solo framework (Nest en todo):** más simple, pero pierde el objetivo didáctico.
- **Lenguajes distintos (Go, Java…):** mayor heterogeneidad, pero multiplica el tooling y la
  generación de código. Fuera del alcance del taller.
- **`@grpc/grpc-js` también en los servicios no-Nest:** posible, pero Connect da tipos de
  primera clase con protobuf-es y servidores sobre `node:http2` sin `proto-loader`.
