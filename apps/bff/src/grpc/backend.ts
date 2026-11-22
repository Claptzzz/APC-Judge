import { Metadata } from '@grpc/grpc-js';
import type { CallOptions } from '@grpc/grpc-js';
import { AUTH_METADATA_KEY } from '@juez/contracts';
import { problems, ranking, submissions, users } from '@juez/contracts/nest';
import { PROTO_PACKAGES, PROTO_ROOT, protoPath } from '@juez/contracts/proto';
import type { ProtoName } from '@juez/contracts/proto';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import type { Observable } from 'rxjs';
import type { Logger } from '../logger.js';
import { fromGrpcError } from './errors.js';
import type { ServiceName } from './errors.js';

/** Datos que viajan en la metadata de cada llamada. */
export interface CallMeta {
  /** JWT crudo del usuario (sin `Bearer`); se omite en las RPC públicas. */
  token?: string | undefined;
  requestId: string;
}

/** Cliente ts-proto (métodos que devuelven Observable) → métodos que devuelven Promise. */
export type Promisified<C> = {
  [K in keyof C]: C[K] extends (req: infer Q, ...rest: never[]) => Observable<infer R>
    ? (req: Q, meta: CallMeta) => Promise<R>
    : never;
};

/** Fachada sobre los cuatro servicios gRPC que consume el BFF (se mockea en los tests). */
export interface Backend {
  users: Promisified<users.UserServiceClient>;
  problems: Promisified<problems.ProblemServiceClient>;
  submissions: Promisified<submissions.SubmissionServiceClient>;
  ranking: Promisified<ranking.RankingServiceClient>;
}

/**
 * Opciones de @grpc/proto-loader compatibles con los tipos de ts-proto (`@juez/contracts/nest`):
 * camelCase, enums numéricos, int64 como string, valores por defecto presentes y oneofs
 * aplanados (`GetProblemRequest` lleva `id` o `slug`).
 */
export const PROTO_LOADER_OPTIONS = {
  includeDirs: [PROTO_ROOT],
  keepCase: false,
  longs: String,
  enums: Number,
  defaults: true,
  arrays: true,
  objects: true,
  oneofs: false,
};

type UnaryFn = (req: unknown, md: Metadata, opts: CallOptions) => Observable<unknown>;

/**
 * Envuelve un cliente gRPC de Nest: agrega `authorization` y `x-request-id` a la metadata,
 * aplica un deadline por llamada y traduce los errores (`UpstreamError`).
 */
export function promisifyClient<C extends object>(
  service: ServiceName,
  client: C,
  timeoutMs: number,
  logger?: Logger,
): Promisified<C> {
  const out: Record<string, unknown> = {};
  for (const [method, fn] of Object.entries(client)) {
    if (typeof fn !== 'function') continue;
    const call = fn as UnaryFn;
    out[method] = async (req: unknown, meta: CallMeta) => {
      const md = new Metadata();
      if (meta.token) md.set(AUTH_METADATA_KEY, `Bearer ${meta.token}`);
      md.set('x-request-id', meta.requestId);
      try {
        return await firstValueFrom(
          call
            .call(client, req, md, { deadline: Date.now() + timeoutMs })
            // Red de seguridad por si el deadline de gRPC no llega a dispararse.
            .pipe(timeout({ first: timeoutMs + 1000 })),
        );
      } catch (err) {
        const mapped = fromGrpcError(service, err);
        logger?.warn(
          {
            service,
            method,
            grpcCode: mapped.grpcCode,
            code: mapped.code,
            requestId: meta.requestId,
            err,
          },
          'llamada gRPC fallida',
        );
        throw mapped;
      }
    };
  }
  return out as Promisified<C>;
}

export interface GrpcAddresses {
  users: string;
  problems: string;
  submissions: string;
  ranking: string;
  timeoutMs: number;
}

const SERVICES = {
  users: { proto: 'users', name: users.USER_SERVICE_NAME },
  problems: { proto: 'problems', name: problems.PROBLEM_SERVICE_NAME },
  submissions: { proto: 'submissions', name: submissions.SUBMISSION_SERVICE_NAME },
  ranking: { proto: 'ranking', name: ranking.RANKING_SERVICE_NAME },
} as const satisfies Record<ServiceName, { proto: ProtoName; name: string }>;

/** Crea los clientes gRPC de Nest (proto cargado en runtime) y la fachada promisificada. */
export function createGrpcBackend(
  addrs: GrpcAddresses,
  logger: Logger,
): { backend: Backend; close(): Promise<void> } {
  const proxies: ClientGrpcProxy[] = [];
  const make = <C extends object>(service: ServiceName): Promisified<C> => {
    const { proto, name } = SERVICES[service];
    const proxy = new ClientGrpcProxy({
      url: addrs[service],
      package: PROTO_PACKAGES[proto],
      protoPath: protoPath(proto),
      loader: PROTO_LOADER_OPTIONS,
    });
    proxies.push(proxy);
    return promisifyClient(service, proxy.getService<C>(name), addrs.timeoutMs, logger);
  };
  const backend: Backend = {
    users: make<users.UserServiceClient>('users'),
    problems: make<problems.ProblemServiceClient>('problems'),
    submissions: make<submissions.SubmissionServiceClient>('submissions'),
    ranking: make<ranking.RankingServiceClient>('ranking'),
  };
  return {
    backend,
    close: async () => {
      await Promise.all(proxies.map((p) => p.close()));
    },
  };
}
