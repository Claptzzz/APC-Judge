import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError } from '@connectrpc/connect';
import { Verdict } from '@juez/contracts/es';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, toBaseUrl } from './config.js';
import { createLogger, SERVICE_NAME } from './logger.js';
import {
  formatMemory,
  isoDate,
  nextPageHint,
  shortDate,
  truncate,
  truncationNotice,
  verdictInfo,
} from './tools/format.js';
import { callOptions, createUpstreamClients } from './upstream/clients.js';
import { classifyUpstreamError, describeUpstreamError } from './upstream/errors.js';
import { TimestampSchema } from '@bufbuild/protobuf/wkt';

describe('config', () => {
  it('usa los valores por defecto de la ficha', () => {
    const c = loadConfig({});
    expect(c.port).toBe(4100);
    expect(c.baseUrls).toEqual({
      users: 'http://localhost:50051',
      problems: 'http://localhost:50052',
      submissions: 'http://localhost:50053',
      ranking: 'http://localhost:50054',
    });
    expect(c.jwt).toEqual({ issuer: 'juez-users', audience: 'juez' });
    expect(c.allowedHosts).toEqual(['localhost', '127.0.0.1', '[::1]']);
    expect(c.allowedOrigins).toEqual([]);
    expect(c.maxBodyBytes).toBe(256 * 1024);
    expect(c.upstreamTimeoutMs).toBe(3000);
  });

  it('lee listas separadas por comas y direcciones', () => {
    const c = loadConfig({
      MCP_PORT: '5000',
      MCP_ALLOWED_HOSTS: ' mcp , localhost ,,',
      MCP_ALLOWED_ORIGINS: 'app.example.com',
      RANKING_GRPC_ADDR: 'https://ranking:50054',
    });
    expect(c.port).toBe(5000);
    expect(c.allowedHosts).toEqual(['mcp', 'localhost']);
    expect(c.allowedOrigins).toEqual(['app.example.com']);
    expect(c.baseUrls.ranking).toBe('https://ranking:50054');
  });

  it('lanza ConfigError con todas las variables inválidas', () => {
    let err: unknown;
    try {
      loadConfig({ MCP_PORT: 'abc', MCP_MAX_BODY_BYTES: '-1', LOG_LEVEL: 'verbose' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).issues).toHaveLength(3);
  });

  it('toBaseUrl', () => {
    expect(toBaseUrl('users:50051')).toBe('http://users:50051');
    expect(toBaseUrl('http://x:1')).toBe('http://x:1');
  });
});

describe('logger', () => {
  it('incluye el nombre del servicio', () => {
    expect(SERVICE_NAME).toBe('mcp');
    expect(createLogger('silent').bindings()).toMatchObject({ name: 'mcp' });
  });
});

describe('errores de los servicios', () => {
  const net = (code: string) => Object.assign(new Error(code), { code });

  it.each([
    [new ConnectError('x', Code.NotFound), 'not_found'],
    [new ConnectError('x', Code.Unavailable), 'unavailable'],
    [new ConnectError('x', Code.DeadlineExceeded), 'unavailable'],
    [new ConnectError('x', Code.Unknown, undefined, undefined, net('ECONNRESET')), 'unavailable'],
    [net('ECONNREFUSED'), 'unavailable'],
    [new Error('wrap', { cause: net('ETIMEDOUT') }), 'unavailable'],
    [new ConnectError('x', Code.InvalidArgument), 'invalid_argument'],
    [new ConnectError('x', Code.PermissionDenied), 'permission_denied'],
    [new ConnectError('x', Code.Unauthenticated), 'unauthenticated'],
    [new ConnectError('x', Code.FailedPrecondition), 'failed_precondition'],
    [new ConnectError('x', Code.Internal), 'other'],
    [new Error('boom'), 'other'],
    ['string', 'other'],
  ])('%s → %s', (err, kind) => {
    expect(classifyUpstreamError(err)).toBe(kind);
  });

  it('nunca dice "no existe" si el servicio no responde', () => {
    const msg = describeUpstreamError(
      new ConnectError('down', Code.Unavailable),
      'problems',
      'El problema no existe.',
    );
    expect(msg).toBe(
      'El servicio de problemas no responde en este momento. Intenta de nuevo en unos segundos.',
    );
    expect(
      describeUpstreamError(
        new ConnectError('x', Code.NotFound),
        'problems',
        'El problema no existe.',
      ),
    ).toBe('El problema no existe.');
    expect(
      describeUpstreamError(
        new ConnectError('contest cerrado', Code.FailedPrecondition),
        'ranking',
        '',
      ),
    ).toBe('El servicio de ranking no puede responder a esto ahora: contest cerrado');
  });
});

describe('formato', () => {
  it('truncate y aviso', () => {
    const short = truncate('hola', 10);
    expect(short).toEqual({ text: 'hola', truncated: false, originalLength: 4 });
    expect(truncationNotice(short, 'Enunciado')).toBe('');
    const long = truncate('abcdef', 3);
    expect(long.text).toBe('abc');
    expect(truncationNotice(long, 'Código')).toContain('Código truncado: se muestran 3 de 6');
  });

  it('veredictos, fechas, memoria y paginación', () => {
    expect(verdictInfo(Verdict.TIME_LIMIT_EXCEEDED).code).toBe('TLE');
    expect(verdictInfo(999 as Verdict).label).toBe('sin veredicto');
    const ts = timestampFromDate(new Date('2026-11-20T14:05:09Z'));
    expect(isoDate(ts)).toBe('2026-11-20T14:05:09.000Z');
    expect(isoDate(undefined)).toBeUndefined();
    expect(shortDate(ts)).toBe('2026-11-20 14:05 UTC');
    expect(shortDate(create(TimestampSchema))).toBe('1970-01-01 00:00 UTC');
    expect(shortDate(undefined)).toBe('sin fecha');
    expect(formatMemory(512)).toBe('512 KB');
    expect(formatMemory(2048)).toBe('2.0 MB');
    expect(nextPageHint('')).toBe('');
    expect(nextPageHint('t1')).toContain('page_token="t1"');
  });
});

describe('clientes Connect', () => {
  it('crea los clientes de los servicios', () => {
    const c = createUpstreamClients({
      problems: 'http://localhost:1',
      submissions: 'http://localhost:2',
      ranking: 'http://localhost:3',
    });
    expect(typeof c.problems.getProblem).toBe('function');
    expect(typeof c.submissions.listSubmissions).toBe('function');
    expect(typeof c.ranking.getScoreboard).toBe('function');
  });

  it('callOptions propaga el JWT del usuario y el request id con timeout', () => {
    expect(callOptions({ token: 'jwt', requestId: 'r1' }, 3000)).toEqual({
      timeoutMs: 3000,
      headers: { authorization: 'Bearer jwt', 'x-request-id': 'r1' },
    });
  });
});
