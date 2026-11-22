import type { Content } from '@google/genai';
import { GraphQLError } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import { createMetrics } from '../metrics.js';
import { silentLogger } from '../test-utils/fixtures.js';
import { AssistantService, toContents, toFunctionDeclaration } from './assistant.service.js';
import type { AssistantOptions, AskInput } from './assistant.service.js';
import type { ChatModel, GenerateParams, ModelTurn } from './gemini.js';
import type { McpConnector, McpSession, McpTool } from './mcp.js';
import { SYSTEM_PROMPT } from './prompt.js';
import { SlidingWindowRateLimiter } from './rate-limiter.js';

const TOOLS: McpTool[] = [
  {
    name: 'ver_submission',
    description: 'Detalle de una submission',
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'ver_problema',
    description: 'Problema',
    inputSchema: { type: 'object', properties: {} },
  },
];

const text = (t: string): ModelTurn => ({
  content: { role: 'model', parts: [{ text: t }] },
  functionCalls: [],
  text: t,
  modelVersion: 'gemini-test-001',
});

const call = (name: string, args: Record<string, unknown>, id?: string): ModelTurn => ({
  content: {
    role: 'model',
    parts: [{ functionCall: { name, args, ...(id && { id }) }, thoughtSignature: 'sig' }],
  },
  functionCalls: [{ name, args, ...(id && { id }) }],
  text: '',
  modelVersion: 'gemini-test-001',
});

function fakeSession(overrides: Partial<McpSession> = {}) {
  return {
    listTools: vi.fn(async () => TOOLS),
    callTool: vi.fn(async (name: string) => ({
      isError: false,
      text: `resultado de ${name}: WRONG_ANSWER en el caso 2`,
    })),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

function setup(
  turns: Array<ModelTurn | ((p: GenerateParams) => Promise<ModelTurn>)>,
  opts: Partial<AssistantOptions> & { session?: ReturnType<typeof fakeSession> } = {},
) {
  const session = opts.session ?? fakeSession();
  const mcp: McpConnector & { connect: ReturnType<typeof vi.fn> } = {
    connect: vi.fn(async () => session),
  };
  // Copia de los contenidos en cada llamada (el arreglo se sigue modificando después).
  const seen: GenerateParams[] = [];
  let i = 0;
  const model: ChatModel & { generate: ReturnType<typeof vi.fn> } = {
    model: 'gemini-test',
    generate: vi.fn(async (p: GenerateParams) => {
      seen.push({ ...p, contents: structuredClone(p.contents) });
      const t = turns[Math.min(i++, turns.length - 1)]!;
      return typeof t === 'function' ? t(p) : t;
    }),
  };
  const metrics = createMetrics({ defaultMetrics: false });
  const service = new AssistantService({
    model,
    mcp,
    logger: silentLogger,
    metrics,
    maxRounds: 5,
    timeoutMs: 2000,
    rateLimitPerMinute: 10,
    ...opts,
  });
  return { service, model, mcp, session, seen, metrics };
}

const input = (overrides: Partial<AskInput> = {}): AskInput => ({
  userId: 'u1',
  token: 'jwt-crudo',
  requestId: 'req-1',
  message: '¿Por qué mi submission s1 dio WA?',
  history: [],
  ...overrides,
});

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    expect(err).toBeInstanceOf(GraphQLError);
    return (err as GraphQLError).extensions.code as string;
  }
}

describe('AssistantService', () => {
  it('responde sin tools cuando el modelo no las pide', async () => {
    const { service, mcp, seen, session } = setup([text('Hola, ¿en qué te ayudo?')]);
    const answer = await service.ask(input({ message: 'hola' }));
    expect(answer).toEqual({ message: 'Hola, ¿en qué te ayudo?', toolCalls: [] });
    expect(mcp.connect).toHaveBeenCalledWith({
      token: 'jwt-crudo',
      requestId: 'req-1',
      signal: expect.any(AbortSignal),
    });
    expect(seen[0]!.systemInstruction).toBe(SYSTEM_PROMPT);
    expect(seen[0]!.forceText).toBe(false);
    expect(seen[0]!.functionDeclarations.map((d) => d.name)).toEqual([
      'ver_submission',
      'ver_problema',
    ]);
    expect(session.close).toHaveBeenCalled();
  });

  it('ciclo de function calling: ejecuta la tool en el MCP y devuelve el resultado a Gemini', async () => {
    const { service, session, seen } = setup([
      call('ver_submission', { id: 's1' }, 'call-1'),
      text('Tu submission falló en el caso 2: revisa los casos borde.'),
    ]);
    const answer = await service.ask(
      input({
        history: [
          { role: 'USER', content: 'hola' },
          { role: 'ASSISTANT', content: 'hola!' },
        ],
      }),
    );
    expect(answer).toEqual({
      message: 'Tu submission falló en el caso 2: revisa los casos borde.',
      toolCalls: [{ name: 'ver_submission', arguments: '{"id":"s1"}', isError: false }],
    });
    expect(session.callTool).toHaveBeenCalledWith('ver_submission', { id: 's1' });
    const second = seen[1]!.contents as Content[];
    expect(second.map((c) => c.role)).toEqual(['user', 'model', 'user', 'model', 'user']);
    // Se devuelve el contenido del modelo tal cual (con la thought signature).
    expect(second[3]!.parts![0]).toMatchObject({ thoughtSignature: 'sig' });
    expect(second[4]!.parts![0]).toEqual({
      functionResponse: {
        id: 'call-1',
        name: 'ver_submission',
        response: { output: 'resultado de ver_submission: WRONG_ANSWER en el caso 2' },
      },
    });
  });

  it('errores de la tool vuelven a Gemini como `error` y se marcan isError', async () => {
    const session = fakeSession({
      callTool: vi
        .fn()
        .mockResolvedValueOnce({ isError: true, text: 'La submission s9 no existe.' })
        .mockRejectedValueOnce(new Error('socket hang up')),
    });
    const { service, seen } = setup(
      [
        {
          ...call('ver_submission', { id: 's9' }),
          functionCalls: [
            { name: 'ver_submission', args: { id: 's9' } },
            { name: 'ver_problema', args: {} },
            { name: 'borrar_todo', args: {} },
          ],
        },
        text('No encontré esa submission.'),
      ],
      { session },
    );
    const answer = await service.ask(input());
    expect(answer.toolCalls).toEqual([
      { name: 'ver_submission', arguments: '{"id":"s9"}', isError: true },
      { name: 'ver_problema', arguments: '{}', isError: true },
      { name: 'borrar_todo', arguments: '{}', isError: true },
    ]);
    const responses = (seen[1]!.contents.at(-1) as Content).parts!.map(
      (p) => p.functionResponse?.response,
    );
    expect(responses).toEqual([
      { error: 'La submission s9 no existe.' },
      { error: 'No se pudo consultar la herramienta en este momento.' },
      { error: 'La herramienta borrar_todo no existe.' },
    ]);
    // Una tool que no está en tools/list nunca se llama.
    expect(session.callTool).toHaveBeenCalledTimes(2);
  });

  it('tope de rondas: tras 5 rondas de tools pide una respuesta final sin tools', async () => {
    const { service, model, session, seen } = setup([
      ...Array.from({ length: 5 }, (_, i) => call('ver_problema', { n: i })),
      async (p) => (p.forceText ? text('Respuesta con lo que tengo.') : call('ver_problema', {})),
    ]);
    const answer = await service.ask(input());
    expect(session.callTool).toHaveBeenCalledTimes(5);
    expect(model.generate).toHaveBeenCalledTimes(6);
    expect(seen.map((p) => p.forceText)).toEqual([false, false, false, false, false, true]);
    expect(answer.toolCalls).toHaveLength(5);
    expect(answer.message).toBe('Respuesta con lo que tengo.');
  });

  it('si el modelo insiste en tools en la ronda final, usa un mensaje de respaldo', async () => {
    const { service } = setup([call('ver_problema', {})], { maxRounds: 1 });
    const answer = await service.ask(input());
    expect(answer.toolCalls).toHaveLength(1);
    expect(answer.message).toMatch(/No pude armar una respuesta/);
  });

  it('rate limit por usuario: 10 por minuto', async () => {
    const { service, model, metrics } = setup([text('ok')], { rateLimitPerMinute: 10 });
    for (let i = 0; i < 10; i++) await service.ask(input());
    const err = await service.ask(input()).catch((e: GraphQLError) => e);
    expect(err).toBeInstanceOf(GraphQLError);
    expect((err as GraphQLError).extensions).toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: expect.any(Number),
    });
    // Otro usuario no se ve afectado.
    await expect(service.ask(input({ userId: 'u2' }))).resolves.toBeDefined();
    expect(model.generate).toHaveBeenCalledTimes(11);
    expect(await metrics.registry.getSingleMetricAsString('assistant_requests_total')).toContain(
      'outcome="rate_limited"',
    );
  });

  it('sin Gemini → ASSISTANT_DISABLED (sin tocar el MCP)', async () => {
    const { service, mcp } = setup([text('x')], { model: undefined });
    expect(await codeOf(service.ask(input()))).toBe('ASSISTANT_DISABLED');
    expect(mcp.connect).not.toHaveBeenCalled();
  });

  it('valida la entrada', async () => {
    const { service } = setup([text('x')], { maxMessageChars: 10 });
    expect(await codeOf(service.ask(input({ message: '   ' })))).toBe('BAD_USER_INPUT');
    expect(await codeOf(service.ask(input({ message: 'x'.repeat(11) })))).toBe('BAD_USER_INPUT');
    expect(
      await codeOf(
        service.ask(
          input({ message: 'hola', history: [{ role: 'USER', content: 'y'.repeat(11) }] }),
        ),
      ),
    ).toBe('BAD_USER_INPUT');
  });

  it('recorta el historial a los últimos mensajes', async () => {
    const { service, seen } = setup([text('ok')], { maxHistoryMessages: 2 });
    await service.ask(
      input({
        message: 'm',
        history: ['a', 'b', 'c'].map((content) => ({ role: 'USER' as const, content })),
      }),
    );
    expect(seen[0]!.contents.map((c) => c.parts![0]!.text)).toEqual(['b', 'c', 'm']);
  });

  it('MCP caído → UNAVAILABLE', async () => {
    const { service, mcp, model } = setup([text('x')]);
    mcp.connect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await codeOf(service.ask(input()))).toBe('UNAVAILABLE');
    expect(model.generate).not.toHaveBeenCalled();
  });

  it('error de Gemini → UNAVAILABLE y cierra la sesión MCP', async () => {
    const { service, session } = setup([
      async () => {
        throw Object.assign(new Error('quota'), { status: 429 });
      },
    ]);
    const err = await service.ask(input()).catch((e: GraphQLError) => e);
    expect((err as GraphQLError).extensions.code).toBe('UNAVAILABLE');
    expect(session.close).toHaveBeenCalled();
  });

  it('timeout total → UNAVAILABLE con mensaje claro y aborta la llamada en curso', async () => {
    let aborted = false;
    const { service } = setup(
      [
        (p) =>
          new Promise<ModelTurn>((_resolve, reject) => {
            p.signal.addEventListener('abort', () => {
              aborted = true;
              reject(new Error('aborted'));
            });
          }),
      ],
      { timeoutMs: 50 },
    );
    const err = await service.ask(input()).catch((e: GraphQLError) => e);
    expect((err as GraphQLError).extensions.code).toBe('UNAVAILABLE');
    expect((err as GraphQLError).message).toMatch(/tardó más de/);
    expect(aborted).toBe(true);
  });
});

describe('conversiones', () => {
  it('tool del MCP → function declaration sin $schema', () => {
    expect(toFunctionDeclaration(TOOLS[0]!)).toEqual({
      name: 'ver_submission',
      description: 'Detalle de una submission',
      parametersJsonSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    });
    expect(toFunctionDeclaration({ name: 'x', inputSchema: { type: 'object' } }).description).toBe(
      '',
    );
  });

  it('historial → contenidos de Gemini', () => {
    expect(toContents([{ role: 'ASSISTANT', content: 'a' }], 'b')).toEqual([
      { role: 'model', parts: [{ text: 'a' }] },
      { role: 'user', parts: [{ text: 'b' }] },
    ]);
  });
});

describe('SlidingWindowRateLimiter', () => {
  it('libera cupo cuando pasa la ventana', () => {
    let now = 0;
    const limiter = new SlidingWindowRateLimiter(2, 1000, () => now);
    expect(limiter.tryAcquire('a').allowed).toBe(true);
    now = 100;
    expect(limiter.tryAcquire('a').allowed).toBe(true);
    expect(limiter.tryAcquire('a')).toEqual({ allowed: false, retryAfterMs: 900 });
    now = 1001;
    expect(limiter.tryAcquire('a').allowed).toBe(true);
  });
});
