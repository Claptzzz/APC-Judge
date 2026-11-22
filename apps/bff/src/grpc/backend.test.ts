// Fachada gRPC (clientes de Nest + proto-loader) contra un servidor @grpc/grpc-js real.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { common } from '@juez/contracts/nest';
import { protoPath } from '@juez/contracts/proto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { silentLogger } from '../test-utils/fixtures.js';
import { createGrpcBackend, PROTO_LOADER_OPTIONS } from './backend.js';
import type { Backend } from './backend.js';
import { ErrorCode, fromGrpcError, isNotFound, UpstreamError } from './errors.js';

type Call = grpc.ServerUnaryCall<Record<string, unknown>, unknown>;
type Callback = grpc.sendUnaryData<unknown>;

/** Espera que la promesa falle y devuelve el error tipado. */
const failure = (p: Promise<unknown>): Promise<UpstreamError> =>
  p.then(
    () => {
      throw new Error('se esperaba un error');
    },
    (e: unknown) => e as UpstreamError,
  );

let server: grpc.Server;
let backend: Backend;
let close: () => Promise<void>;
const seen: Array<{ method: string; request: Record<string, unknown>; md: grpc.Metadata }> = [];

const USER = {
  id: 'u1',
  username: 'alice',
  email: 'a@x.cl',
  role: common.Role.ROLE_SETTER,
  createdAt: { seconds: 1_763_820_000, nanos: 123_000_000 },
};

beforeAll(async () => {
  const def = protoLoader.loadSync(protoPath('users'), PROTO_LOADER_OPTIONS);
  const pkg = grpc.loadPackageDefinition(def) as unknown as {
    juez: { users: { v1: { UserService: { service: grpc.ServiceDefinition } } } };
  };
  server = new grpc.Server();
  const record = (method: string) => (call: Call) =>
    seen.push({ method, request: call.request, md: call.metadata });
  server.addService(pkg.juez.users.v1.UserService.service, {
    getUser: (call: Call, cb: Callback) => {
      record('getUser')(call);
      if (call.request.id === 'missing') {
        cb({ code: grpc.status.NOT_FOUND, details: 'el usuario no existe' });
        return;
      }
      cb(null, { user: USER });
    },
    register: (call: Call, cb: Callback) => {
      record('register')(call);
      cb({ code: grpc.status.ALREADY_EXISTS, details: 'el username ya existe' });
    },
    // Nunca responde: la llamada debe cortar por deadline.
    getUsers: (call: Call) => record('getUsers')(call),
    login: (_call: Call, cb: Callback) =>
      cb({ code: grpc.status.INTERNAL, details: 'stack secreto' }),
    getPublicKey: (_call: Call, cb: Callback) =>
      cb(null, {
        publicKeyPem: 'pem',
        keyId: 'k1',
        algorithm: 'RS256',
        issuer: 'i',
        audience: 'a',
      }),
  });
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, p) =>
      err ? reject(err) : resolve(p),
    ),
  );
  ({ backend, close } = createGrpcBackend(
    {
      users: `127.0.0.1:${port}`,
      problems: '127.0.0.1:1',
      submissions: '127.0.0.1:1',
      ranking: '127.0.0.1:1',
      timeoutMs: 300,
    },
    silentLogger,
  ));
});

afterAll(async () => {
  await close();
  await new Promise<void>((resolve) => server.tryShutdown(() => resolve()));
});

describe('createGrpcBackend', () => {
  it('propaga authorization y x-request-id, y decodifica como los tipos de ts-proto', async () => {
    const res = await backend.users.getUser({ id: 'u1' }, { token: 'jwt', requestId: 'req-1' });
    expect(res.user).toEqual({
      ...USER,
      // int64 como string (longs: String) y enums numéricos.
      createdAt: { seconds: '1763820000', nanos: 123_000_000 },
    });
    const last = seen.at(-1)!;
    expect(last.md.get('authorization')).toEqual(['Bearer jwt']);
    expect(last.md.get('x-request-id')).toEqual(['req-1']);
  });

  it('RPC pública: sin authorization', async () => {
    await backend.users
      .register({ username: 'a', email: 'a@a.cl', password: 'x' }, { requestId: 'r' })
      .catch(() => {});
    expect(seen.at(-1)!.md.get('authorization')).toEqual([]);
  });

  it('traduce los códigos gRPC a extensions.code', async () => {
    const conflict = await failure(
      backend.users.register({ username: 'a', email: 'a@a.cl', password: 'x' }, { requestId: 'r' }),
    );
    expect(conflict).toBeInstanceOf(UpstreamError);
    expect(conflict.code).toBe(ErrorCode.CONFLICT);
    expect(conflict.message).toBe('el username ya existe');

    const nf = await failure(backend.users.getUser({ id: 'missing' }, { requestId: 'r' }));
    expect(isNotFound(nf)).toBe(true);

    const internal = await failure(
      backend.users.login({ usernameOrEmail: 'a', password: 'b' }, { requestId: 'r' }),
    );
    expect(internal.code).toBe(ErrorCode.INTERNAL_SERVER_ERROR);
    expect(internal.message).not.toContain('secreto');
  });

  it('deadline por llamada: un servicio colgado → UNAVAILABLE', async () => {
    const start = Date.now();
    const err = await failure(backend.users.getUsers({ ids: ['u1'] }, { requestId: 'r' }));
    expect(err.code).toBe(ErrorCode.UNAVAILABLE);
    expect(err.grpcCode).toBe(grpc.status.DEADLINE_EXCEEDED);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('servicio caído (puerto cerrado) → UNAVAILABLE con mensaje claro', async () => {
    const err = await failure(backend.problems.getProblem({ id: 'p' }, { requestId: 'r' }));
    expect(err.code).toBe(ErrorCode.UNAVAILABLE);
    expect(err.message).toBe(
      'El servicio de problemas no responde en este momento; reintenta más tarde.',
    );
  });
});

describe('fromGrpcError', () => {
  it.each([
    [grpc.status.NOT_FOUND, 'NOT_FOUND'],
    [grpc.status.UNAVAILABLE, 'UNAVAILABLE'],
    [grpc.status.DEADLINE_EXCEEDED, 'UNAVAILABLE'],
    [grpc.status.UNAUTHENTICATED, 'UNAUTHENTICATED'],
    [grpc.status.PERMISSION_DENIED, 'FORBIDDEN'],
    [grpc.status.INVALID_ARGUMENT, 'BAD_USER_INPUT'],
    [grpc.status.FAILED_PRECONDITION, 'BAD_USER_INPUT'],
    [grpc.status.ALREADY_EXISTS, 'CONFLICT'],
    [grpc.status.INTERNAL, 'INTERNAL_SERVER_ERROR'],
    [grpc.status.UNKNOWN, 'INTERNAL_SERVER_ERROR'],
  ])('código gRPC %i → %s', (code, expected) => {
    expect(fromGrpcError('ranking', { code, details: 'x' }).code).toBe(expected);
  });

  it('errores de red y timeouts locales → UNAVAILABLE; otros → INTERNAL', () => {
    expect(fromGrpcError('users', { code: 'ECONNREFUSED' }).code).toBe('UNAVAILABLE');
    expect(fromGrpcError('users', { name: 'TimeoutError' }).code).toBe('UNAVAILABLE');
    expect(fromGrpcError('users', new Error('boom')).code).toBe('INTERNAL_SERVER_ERROR');
    expect(fromGrpcError('users', undefined).code).toBe('INTERNAL_SERVER_ERROR');
    const same = fromGrpcError('users', { code: grpc.status.NOT_FOUND });
    expect(fromGrpcError('problems', same)).toBe(same);
    expect(same.message).toBe('El recurso no existe.');
  });
});
