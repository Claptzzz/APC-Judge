import { Code, ConnectError, createClient, createRouterTransport } from '@connectrpc/connect';
import { ProblemService } from '@juez/contracts/es';
import { describe, expect, it } from 'vitest';
import { classifyUpstreamError, ConnectProblemsGateway } from '../../src/clients/problems.js';
import { uuid } from '../helpers.js';

function gateway(
  handler: (id: string, headers: Headers) => void | Promise<void>,
  timeoutMs = 3_000,
) {
  const transport = createRouterTransport(({ service }) =>
    service(ProblemService, {
      async getProblem(req, ctx) {
        const id = req.key.case === 'id' ? req.key.value : '';
        await handler(id, ctx.requestHeader);
        return { problem: { id } };
      },
    }),
  );
  return new ConnectProblemsGateway(createClient(ProblemService, transport), timeoutMs);
}

const ctx = { authorization: 'Bearer t', requestId: 'r-1' };

async function codeOf(p: Promise<unknown>) {
  return p.then(
    () => undefined,
    (e: unknown) => ConnectError.from(e).code,
  );
}

describe('classifyUpstreamError', () => {
  it('mapea NotFound, Unavailable, DeadlineExceeded y errores de red', () => {
    expect(classifyUpstreamError(new ConnectError('x', Code.NotFound))).toBe('not_found');
    expect(classifyUpstreamError(new ConnectError('x', Code.Unavailable))).toBe('unavailable');
    expect(classifyUpstreamError(new ConnectError('x', Code.DeadlineExceeded))).toBe('unavailable');
    const refused = Object.assign(new Error('connect'), { code: 'ECONNREFUSED' });
    expect(
      classifyUpstreamError(new ConnectError('x', Code.Unknown, undefined, undefined, refused)),
    ).toBe('unavailable');
    expect(classifyUpstreamError(refused)).toBe('unavailable');
    expect(classifyUpstreamError(new ConnectError('x', Code.Internal))).toBe('other');
    expect(classifyUpstreamError(new Error('x'))).toBe('other');
  });
});

describe('ConnectProblemsGateway', () => {
  it('valida cada problema propagando authorization y x-request-id', async () => {
    const seen: [string, string | null, string | null][] = [];
    await gateway((id, h) => {
      seen.push([id, h.get('authorization'), h.get('x-request-id')]);
    }).assertProblemsExist([uuid(1), uuid(2)], ctx);
    expect(seen.sort()).toEqual([
      [uuid(1), 'Bearer t', 'r-1'],
      [uuid(2), 'Bearer t', 'r-1'],
    ]);
  });

  it('NOT_FOUND si algún problema no existe', async () => {
    const g = gateway((id) => {
      if (id === uuid(2)) throw new ConnectError('no', Code.NotFound);
    });
    await expect(g.assertProblemsExist([uuid(1), uuid(2)], ctx)).rejects.toThrow(uuid(2));
    expect(await codeOf(g.assertProblemsExist([uuid(2)], ctx))).toBe(Code.NotFound);
  });

  it('UNAVAILABLE (nunca NOT_FOUND) si problems no responde, aunque otro no exista', async () => {
    const g = gateway((id) => {
      if (id === uuid(1)) throw new ConnectError('no', Code.NotFound);
      throw new ConnectError('caído', Code.Unavailable);
    });
    expect(await codeOf(g.assertProblemsExist([uuid(1), uuid(2)], ctx))).toBe(Code.Unavailable);
  });

  it('UNAVAILABLE ante timeout (DeadlineExceeded)', async () => {
    const g = gateway(() => new Promise((r) => setTimeout(r, 200)), 20);
    expect(await codeOf(g.assertProblemsExist([uuid(1)], ctx))).toBe(Code.Unavailable);
  });

  it('INTERNAL ante otros errores', async () => {
    const g = gateway(() => {
      throw new ConnectError('raro', Code.FailedPrecondition);
    });
    expect(await codeOf(g.assertProblemsExist([uuid(1)], ctx))).toBe(Code.Internal);
  });

  it('fromBaseUrl contra un puerto cerrado -> UNAVAILABLE', async () => {
    const g = ConnectProblemsGateway.fromBaseUrl('http://127.0.0.1:1');
    expect(
      await codeOf(g.assertProblemsExist([uuid(1)], { authorization: null, requestId: 'r' })),
    ).toBe(Code.Unavailable);
  });
});
