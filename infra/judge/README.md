# Perfil seccomp del judge

El sandbox del judge aísla la red de cada ejecución con `unshare -rn` (namespace de usuario +
namespace de red sin interfaces; ver [services/judge](../../services/judge/README.md#sandbox)).
El perfil seccomp **por defecto** de Docker solo permite `unshare` a contenedores con
`CAP_SYS_ADMIN`, así que en un contenedor normal falla con `Operation not permitted` y el judge
arranca con el warning _"unshare -rn no está disponible"_: los programas de los usuarios
tendrían red (podrían, por ejemplo, llamar a `GetJudgeSpec` y leer las salidas esperadas).

## Qué hace `seccomp.json`

Es el perfil por defecto de Docker **sin cambios** más **una** regla:

```json
{
  "names": ["unshare"],
  "action": "SCMP_ACT_ALLOW",
  "args": [{ "index": 0, "value": 1342177280, "op": "SCMP_CMP_EQ" }],
  "excludes": { "caps": ["CAP_SYS_ADMIN"] }
}
```

`1342177280` = `0x50000000` = `CLONE_NEWUSER | CLONE_NEWNET`: exactamente la llamada que hace
`unshare -rn`. Cualquier otra combinación sigue bloqueada (verificado en el contenedor:
`unshare -r`, `unshare -n`, `unshare -rnm` y `unshare -rnp` fallan con `EPERM`). `clone`,
`clone3`, `mount`, `setns` y el resto de las syscalls de `CAP_SYS_ADMIN` quedan igual que en el
perfil por defecto. No se agregan capabilities ni se usa `seccomp=unconfined`.

Lo usa solo el servicio `judge` del `infra/docker-compose.yml`
(`security_opt: seccomp=./judge/seccomp.json`).

## Riesgo que se acepta

Los programas sandboxeados pueden crear namespaces de usuario (con la misma combinación de
flags, también anidados). Los user namespaces amplían la superficie del kernel expuesta a código
no confiable; es la misma superficie que tiene cualquier proceso sin privilegios en un host
Linux con `kernel.unprivileged_userns_clone=1`. Aceptable para el taller. En Kubernetes la
alternativa sin tocar seccomp es una `NetworkPolicy` de egress para el pod del judge.

Si el host bloquea los user namespaces sin privilegios (AppArmor en Ubuntu ≥ 23.10,
`kernel.unprivileged_userns_clone=0`), el perfil no alcanza: el judge arranca igual, con el
warning, y sin aislamiento de red.

## Origen y cómo regenerarlo

Base: `seccomp/default.json` de [moby/profiles](https://github.com/moby/profiles) en
`seccomp/v0.2.4`, la versión que usa Docker Engine 29.9.x. Para actualizarlo a otra versión de
Docker, descarga el `default.json` correspondiente, inserta la regla de arriba (con el
`comment`) justo después de la regla de `CAP_SYS_ADMIN` y formatea con `pnpm prettier --write`.

Para comprobar que funciona en el stack:

```sh
docker compose -p juez exec judge unshare -rn -- true && echo OK
docker compose -p juez logs judge | grep '"sandbox"'   # unshare debe tener ruta, no null
```
