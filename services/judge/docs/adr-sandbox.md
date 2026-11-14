# ADR 0007 — Sandbox del judge con prlimit + unshare + GNU time

> Borrador. La ficha del judge pide documentar la herramienta de aislamiento en un ADR; la
> fase 1 no permite editar `docs/adr/`, así que este archivo está listo para moverse a
> `docs/adr/0007-sandbox-judge.md` y agregarse al índice.

- **Estado:** Propuesta
- **Fecha:** 2026-11-11

## Contexto

El judge ejecuta código arbitrario de usuarios (C++17 y Python 3). Necesita límites de tiempo,
memoria y salida, sin red y en un directorio propio, medir tiempo y memoria de cada caso, y
correr como contenedor no-root sin privilegios especiales en local, en CI (runners de GitHub) y
en Kubernetes.

## Decisión

Envolver cada ejecución con herramientas estándar de util-linux y GNU time, sin dependencias
nativas en Node:

```
unshare -rn -- /usr/bin/time -f %M -o time.txt prlimit --core=0 --as=… --cpu=… --fsize=… -- programa
```

- **Tiempo:** timer de pared en Node que mata el grupo de procesos (`detached` + `kill(-pgid)`);
  `prlimit --cpu` como respaldo.
- **Memoria:** `prlimit --as`. Un fallo de asignación (`bad_alloc`, `MemoryError`, `ENOMEM` en
  `exec`) o un RSS sobre el límite es `MEMORY_LIMIT_EXCEEDED`.
- **Salida:** corte de stdout en `JUDGE_MAX_OUTPUT_KB` + `prlimit --fsize`.
- **Red:** `unshare -rn` (user + network namespace, sin privilegios). Si el entorno no lo
  permite, el judge sigue sin aislamiento de red y lo advierte al arrancar.
- **Medición:** tiempo de pared desde Node; RSS máximo con GNU time (`%M`).
- Directorio temporal por submission que se borra siempre; entorno mínimo para el proceso.

## Consecuencias

- Sin dependencias nativas ni privilegios: funciona en la imagen `node:*-slim` con `g++`,
  `python3`, `time` y `util-linux`, y en los runners de GitHub para los tests.
- Con el seccomp por defecto de Docker (y con AppArmor restrictivo) `unshare -rn` no está
  disponible: hay que habilitarlo con un perfil seccomp propio o compensar con una
  `NetworkPolicy` de egress en Kubernetes.
- El programa corre con el mismo uid que el worker: puede leer lo que el worker puede leer y no
  hay límite de procesos. Aceptable para el taller; no para un juez público.
- `--as` limita memoria virtual, no RSS: es conservador con runtimes que reservan mucho espacio
  de direcciones.

## Alternativas consideradas

- **isolate / nsjail:** aislamiento completo (cgroups, uid propio, mount namespace), pero
  requieren privilegios (`CAP_SYS_ADMIN` o contenedor privilegiado) y binarios externos.
- **Un contenedor por ejecución (Docker-in-Docker o API de Docker):** aislamiento fuerte, pero
  exige acceso al daemon (equivalente a root en el host) y suma cientos de ms por caso.
- **gVisor / Firecracker:** muy seguros, demasiado costosos de operar para el taller.
- **cgroups v2 directamente:** medición y límite de memoria exactos, pero requiere delegación de
  cgroups al contenedor.
