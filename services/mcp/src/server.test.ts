import type { AddressInfo } from 'node:net';
import { Code, ConnectError } from '@connectrpc/connect';
import { create } from '@bufbuild/protobuf';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';
import {
  GetProblemResponseSchema,
  GetSubmissionResponseSchema,
  ListSubmissionsResponseSchema,
  Verdict,
} from '@juez/contracts/es';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicKeyUnavailableError } from './auth/jwt.js';
import type { JwtVerifier } from './auth/jwt.js';
import { createApp } from './server.js';
import type { App } from './server.js';
import {
  ALICE,
  BOB_ID,
  CONTEST_ID,
  createKeys,
  fakeClients,
  PROBLEM_ID,
  readyVerifier,
  sampleProblem,
  sampleSubmission,
  signToken,
  silentLogger,
  SUBMISSION_ID,
} from './test-utils/fixtures.js';
import type { FakeClients, Keys } from './test-utils/fixtures.js';
import { TOOL_NAMES } from './tools/tools.js';

let keys: Keys;
let verifier: JwtVerifier;
let token: string;

beforeAll(async () => {
  keys = await createKeys();
  verifier = await readyVerifier(keys);
  token = await signToken(keys);
});

interface Running {
  app: App;
  url: URL;
  clients: FakeClients;
}

async function start(
  overrides: {
    verifier?: Pick<JwtVerifier, 'verify' | 'hasPublicKey'>;
    maxBodyBytes?: number;
  } = {},
): Promise<Running> {
  const clients = fakeClients();
  const app = createApp({
    verifier: overrides.verifier ?? verifier,
    clients,
    logger: silentLogger,
    allowedHosts: ['127.0.0.1', 'localhost'],
    allowedOrigins: [],
    maxBodyBytes: overrides.maxBodyBytes ?? 64 * 1024,
    upstreamTimeoutMs: 3000,
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address() as AddressInfo;
  return { app, url: new URL(`http://127.0.0.1:${port}/mcp`), clients };
}

async function connect(
  url: URL,
  opts: { token?: string; mode?: 'legacy' | 'auto'; headers?: Record<string, string> } = {},
): Promise<Client> {
  const client = new Client(
    { name: 'test-bff', version: '1.0.0' },
    { versionNegotiation: { mode: opts.mode ?? 'legacy' } },
  );
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: { authorization: `Bearer ${opts.token ?? token}`, ...opts.headers },
    },
  });
  await client.connect(transport);
  return client;
}

const text = (r: CallToolResult) =>
  r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

/** POST crudo a /mcp (sin cliente MCP) para probar los rechazos HTTP. */
function rawPost(url: URL, headers: Record<string, string> = {}, body?: string) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body:
      body ??
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'raw', version: '1' },
        },
      }),
  });
}

describe.each(['legacy', 'auto'] as const)('MCP server (cliente en modo %s)', (mode) => {
  let running: Running;
  let client: Client;

  beforeEach(async () => {
    running = await start();
    client = await connect(running.url, { mode });
  });

  afterEach(async () => {
    await client.close();
    await running.app.close();
  });

  it('negocia la era de protocolo esperada', () => {
    expect(client.getProtocolEra()).toBe(mode === 'auto' ? 'modern' : 'legacy');
  });

  it('lista las 5 tools, todas de solo lectura y con descripción', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.description?.length).toBeGreaterThan(60);
      expect(tool.inputSchema.type).toBe('object');
    }
    const mis = tools.find((t) => t.name === 'mis_submissions')!;
    expect(Object.keys(mis.inputSchema.properties ?? {})).not.toContain('user_id');
  });

  it('listar_problemas: filtros, texto compacto y structuredContent', async () => {
    const result = (await client.callTool({
      name: 'listar_problemas',
      arguments: { tags: ['matematicas'], dificultad: 'facil', page_size: 5 },
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('Suma de dos números (slug: suma');
    expect(text(result)).toContain('page_token="pagina-2"');
    expect(result.structuredContent).toMatchObject({
      problems: [{ id: PROBLEM_ID, slug: 'suma', difficulty: 'fácil' }],
      next_page_token: 'pagina-2',
    });
    expect(running.clients.problems.listProblems).toHaveBeenCalledWith(
      { pageSize: 5, pageToken: '', tags: ['matematicas'], difficulty: 1 },
      expect.anything(),
    );
  });

  it('ver_problema por slug', async () => {
    const result = (await client.callTool({
      name: 'ver_problema',
      arguments: { slug: 'suma' },
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('# Suma de dos números');
    expect(text(result)).toContain('Límites: 1000 ms, 256 MB');
    expect(text(result)).toContain('Entrada:\n1 2');
    expect(result.structuredContent).toMatchObject({
      problem: { slug: 'suma', statement_truncated: false, time_limit_ms: 1000 },
    });
    expect(running.clients.problems.getProblem).toHaveBeenCalledWith(
      { key: { case: 'slug', value: 'suma' } },
      expect.anything(),
    );
  });

  it('mis_submissions usa el sub del token e ignora un user_id ajeno', async () => {
    const result = (await client.callTool({
      name: 'mis_submissions',
      arguments: { user_id: BOB_ID, problem_id: PROBLEM_ID },
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    const [req] = running.clients.submissions.listSubmissions.mock.calls[0]!;
    expect(req.userId).toBe(ALICE.sub);
    expect(req.problemId).toBe(PROBLEM_ID);
    expect(JSON.stringify(req)).not.toContain(BOB_ID);
    expect(text(result)).toContain('submission(s) de alice');
    expect(text(result)).toContain('WA (Wrong Answer) · 3/10 casos');
    expect(result.structuredContent).toMatchObject({
      user_id: ALICE.sub,
      submissions: [{ id: SUBMISSION_ID, verdict: 'WA', passed_cases: 3, total_cases: 10 }],
    });
  });

  it('ver_submission: resumen del veredicto con límites del problema y código', async () => {
    const result = (await client.callTool({
      name: 'ver_submission',
      arguments: { id: SUBMISSION_ID },
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    const body = text(result);
    expect(body).toContain('Veredicto: WA — Wrong Answer');
    expect(body).toContain('Casos: pasó 3 de 10.');
    expect(body).toContain('Tiempo: 12 ms (límite 1000 ms)');
    expect(body).toContain('Memoria: 3.3 MB (límite 256 MB)');
    expect(body).toContain('printf("%d",a-b)');
    expect(result.structuredContent).toMatchObject({
      submission: { verdict: 'WA', passed_cases: 3, total_cases: 10, time_ms: 12, memory_kb: 3400 },
      problem: { id: PROBLEM_ID, time_limit_ms: 1000, memory_limit_mb: 256 },
    });
  });

  it('ver_scoreboard: filas, leyenda de problemas y fila del usuario marcada', async () => {
    const result = (await client.callTool({
      name: 'ver_scoreboard',
      arguments: { contest_id: CONTEST_ID },
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    const body = text(result);
    expect(body).toContain(
      '#1 bob — 2 resuelto(s), 75 min de penalización — P1✓ min 20 (1 int.) 1º',
    );
    expect(body).toContain('#2 alice ← tú');
    expect(body).toContain('P2✗ (3 int.)');
    expect(body).toContain(`P1 = ${PROBLEM_ID}`);
    expect(result.structuredContent).toMatchObject({ contest_id: CONTEST_ID, my_rank: 2 });
  });
});

describe('MCP server — autenticación y propagación del token', () => {
  let running: Running;
  beforeEach(async () => {
    running = await start();
  });
  afterEach(async () => {
    await running.app.close();
  });

  it('sin token → 401 con WWW-Authenticate', async () => {
    const res = await rawPost(running.url);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer .*invalid_token/);
    expect(await res.json()).toMatchObject({
      error: { message: expect.stringMatching(/Authorization/) },
    });
  });

  it.each([
    ['formato distinto de Bearer', async () => 'Basic dXNlcjpwYXNz'],
    ['firma inválida', async () => `Bearer ${await signToken(await createKeys())}`],
    ['expirado', async () => `Bearer ${await signToken(keys, { expiresIn: '-1m' })}`],
    ['audience equivocada', async () => `Bearer ${await signToken(keys, { audience: 'otra' })}`],
    ['rol desconocido', async () => `Bearer ${await signToken(keys, { role: 'ROOT' })}`],
  ])('token con %s → 401', async (_name, header) => {
    const res = await rawPost(running.url, { authorization: await header() });
    expect(res.status).toBe(401);
  });

  it('el cliente MCP del SDK tampoco conecta sin un token válido', async () => {
    await expect(connect(running.url, { token: 'no-es-un-jwt' })).rejects.toThrow();
    expect(running.clients.problems.listProblems).not.toHaveBeenCalled();
  });

  it('propaga el JWT, el x-request-id y el timeout en cada llamada Connect', async () => {
    const client = await connect(running.url, { headers: { 'x-request-id': 'req-123' } });
    await client.callTool({ name: 'listar_problemas', arguments: {} });
    await client.callTool({ name: 'ver_submission', arguments: { id: SUBMISSION_ID } });
    await client.callTool({ name: 'ver_scoreboard', arguments: { contest_id: CONTEST_ID } });
    await client.close();

    const calls = [
      ...running.clients.problems.listProblems.mock.calls,
      ...running.clients.submissions.getSubmission.mock.calls,
      ...running.clients.problems.getProblem.mock.calls,
      ...running.clients.ranking.getScoreboard.mock.calls,
    ];
    expect(calls).toHaveLength(4);
    for (const [, options] of calls) {
      expect(options).toEqual({
        timeoutMs: 3000,
        headers: { authorization: `Bearer ${token}`, 'x-request-id': 'req-123' },
      });
    }
  });

  it('cada usuario ve sus propias submissions (sin estado compartido entre requests)', async () => {
    const bobToken = await signToken(keys, { sub: BOB_ID, username: 'bob' });
    const alice = await connect(running.url);
    const bob = await connect(running.url, { token: bobToken });
    await Promise.all([
      alice.callTool({ name: 'mis_submissions', arguments: {} }),
      bob.callTool({ name: 'mis_submissions', arguments: {} }),
    ]);
    await Promise.all([alice.close(), bob.close()]);
    const userIds = running.clients.submissions.listSubmissions.mock.calls.map(([r]) => r.userId);
    expect(userIds.sort()).toEqual([ALICE.sub, BOB_ID].sort());
    const headers = running.clients.submissions.listSubmissions.mock.calls.map(([r, o]) => [
      r.userId,
      (o as { headers: Record<string, string> }).headers.authorization,
    ]);
    expect(headers).toContainEqual([BOB_ID, `Bearer ${bobToken}`]);
    expect(headers).toContainEqual([ALICE.sub, `Bearer ${token}`]);
  });

  it('si users no responde y no hay llave → 503 (no 401)', async () => {
    const down = {
      hasPublicKey: () => false,
      verify: vi.fn().mockRejectedValue(new PublicKeyUnavailableError('sin llave')),
    };
    const other = await start({ verifier: down });
    const res = await rawPost(other.url, { authorization: `Bearer ${token}` });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/usuarios no responde/);
    await other.app.close();
  });
});

describe('MCP server — errores de los servicios como isError', () => {
  let running: Running;
  let client: Client;
  beforeEach(async () => {
    running = await start();
    client = await connect(running.url);
  });
  afterEach(async () => {
    await client.close();
    await running.app.close();
  });

  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;

  it('NotFound → "el problema no existe"', async () => {
    running.clients.problems.getProblem.mockRejectedValue(new ConnectError('nope', Code.NotFound));
    const result = await call('ver_problema', { id: PROBLEM_ID });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(`El problema con id ${PROBLEM_ID} no existe.`);
  });

  it('respuesta sin el recurso también es "no existe"', async () => {
    running.clients.submissions.getSubmission.mockResolvedValue(
      create(GetSubmissionResponseSchema, {}),
    );
    const result = await call('ver_submission', { id: SUBMISSION_ID });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(`La submission ${SUBMISSION_ID} no existe.`);
  });

  it.each([
    ['Unavailable', new ConnectError('down', Code.Unavailable)],
    ['DeadlineExceeded', new ConnectError('timeout', Code.DeadlineExceeded)],
    ['error de red', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })],
  ])('ranking con %s → "el servicio de ranking no responde"', async (_name, err) => {
    running.clients.ranking.getScoreboard.mockRejectedValue(err);
    const result = await call('ver_scoreboard', { contest_id: CONTEST_ID });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^El servicio de ranking no responde/);
  });

  it.each([
    [Code.PermissionDenied, /no tiene permiso/],
    [Code.Unauthenticated, /rechazó la sesión/],
    [Code.InvalidArgument, /rechazó los argumentos: page_token inválido/],
    [Code.Internal, /Error inesperado en el servicio de submissions/],
  ])('submissions con código %s → mensaje entendible', async (code, message) => {
    running.clients.submissions.listSubmissions.mockRejectedValue(
      new ConnectError('page_token inválido', code),
    );
    const result = await call('mis_submissions', {});
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(message);
  });

  it('argumentos inválidos → isError de validación, sin llamar al servicio', async () => {
    const both = await call('ver_problema', { id: PROBLEM_ID, slug: 'suma' });
    const none = await call('ver_problema', {});
    const badUuid = await call('ver_submission', { id: 'no-es-uuid' });
    for (const r of [both, none, badUuid]) expect(r.isError).toBe(true);
    expect(text(both)).toContain('Indica exactamente uno: id o slug');
    expect(running.clients.problems.getProblem).not.toHaveBeenCalled();
    expect(running.clients.submissions.getSubmission).not.toHaveBeenCalled();
  });

  it('ver_submission responde aunque problems falle (sin límites)', async () => {
    running.clients.problems.getProblem.mockRejectedValue(
      new ConnectError('down', Code.Unavailable),
    );
    const result = await call('ver_submission', { id: SUBMISSION_ID });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('Tiempo: 12 ms · Memoria');
    expect(result.structuredContent).toMatchObject({ problem: null });
  });

  it('submission pendiente: no muestra casos/tiempo/memoria en 0 como si fueran reales', async () => {
    const pending = sampleSubmission({
      verdict: Verdict.PENDING,
      passedCases: 0,
      totalCases: 0,
      timeMs: 0,
      memoryKb: 0,
      judgedAt: undefined,
    });
    running.clients.submissions.getSubmission.mockResolvedValue(
      create(GetSubmissionResponseSchema, { submission: pending }),
    );
    running.clients.submissions.listSubmissions.mockResolvedValue(
      create(ListSubmissionsResponseSchema, { submissions: [pending] }),
    );
    const detail = text(await call('ver_submission', { id: SUBMISSION_ID }));
    expect(detail).toContain('Todavía no tiene veredicto final');
    expect(detail).toContain('Límites del problema: 1000 ms, 256 MB.');
    expect(detail).not.toMatch(/Casos: pasó|Tiempo: 0 ms/);
    const list = text(await call('mis_submissions', {}));
    expect(list).toContain('PENDING (pendiente) · sin veredicto final · C++17');
    expect(list).not.toContain('0/0 casos');
  });

  it('ver_submission de otro usuario: sin código fuente', async () => {
    running.clients.submissions.getSubmission.mockResolvedValue(
      create(GetSubmissionResponseSchema, {
        submission: sampleSubmission({ userId: BOB_ID, sourceCode: '' }),
      }),
    );
    const result = await call('ver_submission', { id: SUBMISSION_ID });
    expect(text(result)).toContain('El código fuente no es visible');
  });

  it('trunca enunciados largos y lo avisa', async () => {
    running.clients.problems.getProblem.mockResolvedValue(
      create(GetProblemResponseSchema, { problem: sampleProblem('x'.repeat(10_000)) }),
    );
    const result = await call('ver_problema', { id: PROBLEM_ID });
    expect(text(result)).toContain('[Enunciado truncado: se muestran 4000 de 10000 caracteres]');
    expect(result.structuredContent).toMatchObject({
      problem: { statement_truncated: true, statement_length: 10_000 },
    });
    const statement = (result.structuredContent as { problem: { statement: string } }).problem
      .statement;
    expect(statement).toHaveLength(4000);
  });
});

describe('MCP server — HTTP, salud y protección', () => {
  let running: Running;
  beforeAll(async () => {
    running = await start({ maxBodyBytes: 1024 });
  });
  afterAll(async () => {
    await running.app.close();
  });

  const base = () => `http://127.0.0.1:${running.url.port}`;

  it('/health y /ready', async () => {
    expect((await fetch(`${base()}/health`)).status).toBe(200);
    const ready = await fetch(`${base()}/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ok', checks: { usersPublicKey: true } });
  });

  it('/ready → 503 sin la llave pública de users', async () => {
    const other = await start({
      verifier: { hasPublicKey: () => false, verify: vi.fn() },
    });
    const res = await fetch(`http://127.0.0.1:${other.url.port}/ready`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'unavailable', checks: { usersPublicKey: false } });
    await other.app.close();
  });

  it('rutas desconocidas → 404 y métodos no GET → 405', async () => {
    expect((await fetch(`${base()}/nada`)).status).toBe(404);
    expect((await fetch(`${base()}/health`, { method: 'POST' })).status).toBe(405);
  });

  it('Host no permitido → 403 (DNS rebinding), antes de autenticar', async () => {
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: Number(running.url.port),
          path: '/mcp',
          method: 'POST',
          headers: { host: 'evil.example.com', 'content-type': 'application/json' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end('{}');
    });
    expect(status).toBe(403);
  });

  it('Origin de navegador no permitido → 403', async () => {
    const res = await rawPost(running.url, {
      authorization: `Bearer ${token}`,
      origin: 'http://evil.example.com',
    });
    expect(res.status).toBe(403);
  });

  it('body mayor al límite → 413', async () => {
    const res = await rawPost(
      running.url,
      { authorization: `Bearer ${token}` },
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(4096) } }),
    );
    expect(res.status).toBe(413);
  });
});
