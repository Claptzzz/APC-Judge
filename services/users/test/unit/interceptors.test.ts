import { Code, ConnectError, createClient, createRouterTransport } from '@connectrpc/connect';
import { UserService } from '@juez/contracts/es';
import { describe, expect, it } from 'vitest';
import { kLogger, kRequestId } from '../../src/grpc/context.js';
import {
  codeName,
  requestContextInterceptor,
  resolveRequestId,
} from '../../src/grpc/interceptors.js';
import { createMetrics } from '../../src/metrics.js';
import { memoryLogger } from '../helpers.js';

describe('resolveRequestId', () => {
  it('reutiliza un id válido y genera uno si falta o es sospechoso', () => {
    expect(resolveRequestId('abc-123')).toBe('abc-123');
    for (const bad of [null, '', 'con espacio', 'x'.repeat(129), 'a\nb']) {
      expect(resolveRequestId(bad)).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});

describe('codeName', () => {
  it('usa los nombres canónicos', () => {
    expect(codeName(Code.AlreadyExists)).toBe('already_exists');
    expect(codeName(Code.Unauthenticated)).toBe('unauthenticated');
    expect(codeName(999 as Code)).toBe('unknown');
  });
});

type Ctx = { values: { get: <T>(k: { id: symbol; defaultValue: T }) => T } };

function setup(handler: (ctx: Ctx) => unknown) {
  const log = memoryLogger();
  const metrics = createMetrics({ defaultMetrics: false });
  const transport = createRouterTransport(
    (router) =>
      router.service(UserService, {
        getPublicKey: (_req: unknown, ctx: Ctx) => handler(ctx),
      } as never),
    { router: { interceptors: [requestContextInterceptor(log.logger, metrics)] } },
  );
  return { client: createClient(UserService, transport), log, metrics };
}

describe('requestContextInterceptor', () => {
  it('deja requestId y logger en el contexto y devuelve x-request-id', async () => {
    let seen: { id?: string; hasLogger?: boolean } = {};
    const { client, metrics } = setup((ctx) => {
      seen = { id: ctx.values.get(kRequestId), hasLogger: !!ctx.values.get(kLogger) };
      return {};
    });
    let header: Headers | undefined;
    await client.getPublicKey(
      {},
      { headers: { 'x-request-id': 'r-1' }, onHeader: (h) => (header = h) },
    );
    expect(seen).toEqual({ id: 'r-1', hasLogger: true });
    expect(header?.get('x-request-id')).toBe('r-1');
    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /rpc_server_duration_seconds_count\{[^}]*method="GetPublicKey"[^}]*code="ok"[^}]*\} 1/,
    );
  });

  it('deja pasar los ConnectError con su código y les agrega x-request-id', async () => {
    const { client, log } = setup(() => {
      throw new ConnectError('no', Code.PermissionDenied);
    });
    const err = ConnectError.from(
      await client.getPublicKey({}, { headers: { 'x-request-id': 'r-2' } }).catch((e) => e),
    );
    expect(err.code).toBe(Code.PermissionDenied);
    expect(err.metadata.get('x-request-id')).toBe('r-2');
    expect(log.lines().at(-1)).toMatchObject({
      level: 'info',
      code: 'permission_denied',
      msg: 'no',
    });
  });

  it('oculta los errores inesperados como internal y los registra como error', async () => {
    const { client, log } = setup(() => {
      throw new Error('detalle sensible de la BD');
    });
    const err = ConnectError.from(await client.getPublicKey({}).catch((e) => e));
    expect(err.code).toBe(Code.Internal);
    expect(err.rawMessage).toBe('Error interno');
    const line = log.lines().at(-1)!;
    expect(line).toMatchObject({ level: 'error', code: 'internal' });
    expect((line.err as { message: string }).message).toBe('detalle sensible de la BD');
  });
});
