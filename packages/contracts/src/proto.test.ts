import { existsSync } from 'node:fs';
import { loadSync } from '@grpc/proto-loader';
import { describe, expect, it } from 'vitest';
import { PROTO_FILES, PROTO_PACKAGES, PROTO_ROOT, protoPath } from './proto.js';
import type { ProtoName } from './proto.js';

describe('proto', () => {
  it('cada .proto existe dentro del paquete (copiado en generate)', () => {
    expect(existsSync(PROTO_ROOT)).toBe(true);
    for (const name of Object.keys(PROTO_FILES) as ProtoName[]) {
      expect(existsSync(protoPath(name)), protoPath(name)).toBe(true);
    }
  });

  it('PROTO_PACKAGES sigue la convención juez.<nombre>.v1', () => {
    for (const [name, pkg] of Object.entries(PROTO_PACKAGES)) {
      expect(pkg).toBe(`juez.${name}.v1`);
    }
  });

  it('@grpc/proto-loader carga todos los servicios (como NestJS en runtime)', () => {
    const names = Object.keys(PROTO_FILES) as ProtoName[];
    const definition = loadSync(names.map(protoPath), { includeDirs: [PROTO_ROOT] });
    expect(Object.keys(definition)).toEqual(
      expect.arrayContaining([
        'juez.users.v1.UserService',
        'juez.problems.v1.ProblemService',
        'juez.submissions.v1.SubmissionService',
        'juez.ranking.v1.RankingService',
        'juez.events.v1.SubmissionJudged',
        'google.protobuf.Timestamp',
      ]),
    );
  });
});
