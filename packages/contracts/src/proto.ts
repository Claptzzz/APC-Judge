// Ubicación de los .proto para cargarlos en runtime (@grpc/proto-loader en NestJS).
//   import { PROTO_ROOT, protoPath } from '@juez/contracts/proto';
//   options: { package: 'juez.users.v1', protoPath: protoPath('users'),
//              loader: { includeDirs: [PROTO_ROOT] } }
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Directorio raíz de los .proto (contiene `juez/<paquete>/v1/*.proto`). */
export const PROTO_ROOT = fileURLToPath(new URL('../proto', import.meta.url));

/** Ruta de cada archivo, relativa a PROTO_ROOT. */
export const PROTO_FILES = {
  common: 'juez/common/v1/common.proto',
  users: 'juez/users/v1/users.proto',
  problems: 'juez/problems/v1/problems.proto',
  submissions: 'juez/submissions/v1/submissions.proto',
  ranking: 'juez/ranking/v1/ranking.proto',
  events: 'juez/events/v1/events.proto',
} as const;

export type ProtoName = keyof typeof PROTO_FILES;

/** Nombre del paquete protobuf de cada archivo. */
export const PROTO_PACKAGES = {
  common: 'juez.common.v1',
  users: 'juez.users.v1',
  problems: 'juez.problems.v1',
  submissions: 'juez.submissions.v1',
  ranking: 'juez.ranking.v1',
  events: 'juez.events.v1',
} as const satisfies Record<ProtoName, string>;

/** Ruta absoluta del .proto indicado. */
export function protoPath(name: ProtoName): string {
  return join(PROTO_ROOT, PROTO_FILES[name]);
}
