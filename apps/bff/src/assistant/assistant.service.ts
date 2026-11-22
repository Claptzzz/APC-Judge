import type { Content, FunctionDeclaration, Part } from '@google/genai';
import { GraphQLError } from 'graphql';
import type { AssistantAnswer, AssistantMessageInput, AssistantToolCall } from '../gen/graphql.js';
import { ErrorCode, gqlError } from '../grpc/errors.js';
import type { Logger } from '../logger.js';
import type { Metrics } from '../metrics.js';
import type { ChatModel } from './gemini.js';
import type { McpConnector, McpSession, McpTool } from './mcp.js';
import { SYSTEM_PROMPT } from './prompt.js';
import { SlidingWindowRateLimiter } from './rate-limiter.js';

export interface AssistantOptions {
  /** `undefined` = Gemini sin configurar: `askAssistant` responde ASSISTANT_DISABLED. */
  model: ChatModel | undefined;
  mcp: McpConnector;
  logger: Logger;
  metrics?: Pick<Metrics, 'assistantRequests'>;
  maxRounds: number;
  timeoutMs: number;
  rateLimitPerMinute: number;
  /** Límites de entrada (protegen la cuota de Gemini). */
  maxMessageChars?: number;
  maxHistoryMessages?: number;
}

export interface AskInput {
  userId: string;
  token: string;
  requestId: string;
  message: string;
  history: readonly AssistantMessageInput[];
}

class AssistantTimeoutError extends Error {
  override name = 'AssistantTimeoutError';
}

const FALLBACK_MESSAGE =
  'No pude armar una respuesta con la información disponible. Intenta con una pregunta más específica (por ejemplo, indicando el id de la submission o el problema).';

/** Tool del MCP → function declaration de Gemini (JSON Schema tal cual, sin `$schema`). */
export function toFunctionDeclaration(tool: McpTool): FunctionDeclaration {
  const { $schema: _ignored, ...schema } = tool.inputSchema;
  return {
    name: tool.name,
    description: tool.description ?? '',
    parametersJsonSchema: schema,
  };
}

/** Historial del cliente → contenidos de Gemini (USER → user, ASSISTANT → model). */
export function toContents(history: readonly AssistantMessageInput[], message: string): Content[] {
  return [
    ...history.map((m) => ({
      role: m.role === 'ASSISTANT' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
    { role: 'user', parts: [{ text: message }] },
  ];
}

/**
 * Asistente: Gemini con function calling sobre las tools del MCP server, ejecutadas con la
 * identidad del usuario. Ciclo de hasta `maxRounds` rondas de tools; al llegar al tope se
 * pide una última respuesta sin tools. Todo dentro de un timeout total (`timeoutMs`).
 */
export class AssistantService {
  private readonly limiter: SlidingWindowRateLimiter;
  private readonly maxMessageChars: number;
  private readonly maxHistoryMessages: number;

  constructor(private readonly opts: AssistantOptions) {
    this.limiter = new SlidingWindowRateLimiter(opts.rateLimitPerMinute, 60_000);
    this.maxMessageChars = opts.maxMessageChars ?? 4_000;
    this.maxHistoryMessages = opts.maxHistoryMessages ?? 20;
  }

  get enabled(): boolean {
    return this.opts.model !== undefined;
  }

  async ask(input: AskInput): Promise<AssistantAnswer> {
    const model = this.opts.model;
    if (!model) {
      this.count('disabled');
      throw gqlError(
        ErrorCode.ASSISTANT_DISABLED,
        'El asistente no está habilitado en este servidor (falta la configuración de Gemini).',
      );
    }
    const message = input.message.trim();
    if (!message) throw gqlError(ErrorCode.BAD_USER_INPUT, 'La pregunta no puede estar vacía.');
    if (
      message.length > this.maxMessageChars ||
      input.history.some((m) => m.content.length > this.maxMessageChars)
    ) {
      throw gqlError(
        ErrorCode.BAD_USER_INPUT,
        `Cada mensaje puede tener como máximo ${this.maxMessageChars} caracteres.`,
      );
    }

    const limit = this.limiter.tryAcquire(input.userId);
    if (!limit.allowed) {
      this.count('rate_limited');
      const retryAfterSeconds = Math.ceil(limit.retryAfterMs / 1000);
      throw gqlError(
        ErrorCode.RATE_LIMITED,
        `Hiciste demasiadas preguntas seguidas al asistente; espera ${retryAfterSeconds} s.`,
        { retryAfterSeconds },
      );
    }

    const log = this.opts.logger.child({ requestId: input.requestId, userId: input.userId });
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new AssistantTimeoutError('timeout del asistente')),
      this.opts.timeoutMs,
    );
    let session: McpSession | undefined;
    try {
      const signal = controller.signal;
      try {
        session = await this.opts.mcp.connect({
          token: input.token,
          requestId: input.requestId,
          signal,
        });
      } catch (err) {
        if (signal.aborted) throw err;
        log.warn({ err }, 'no se pudo conectar con el MCP server');
        throw gqlError(
          ErrorCode.UNAVAILABLE,
          'El asistente no puede consultar los datos del juez en este momento; reintenta más tarde.',
        );
      }
      const tools = await session.listTools();
      const answer = await this.loop(model, session, tools, input, message, signal, log);
      this.count('ok');
      return answer;
    } catch (err) {
      if (controller.signal.aborted) {
        this.count('timeout');
        log.warn({ timeoutMs: this.opts.timeoutMs }, 'el asistente superó el tiempo máximo');
        throw gqlError(
          ErrorCode.UNAVAILABLE,
          `El asistente tardó más de ${Math.round(this.opts.timeoutMs / 1000)} s en responder; reintenta más tarde.`,
        );
      }
      if (err instanceof GraphQLError) {
        this.count('error');
        throw err;
      }
      this.count('error');
      log.error({ err }, 'error del asistente');
      throw gqlError(
        ErrorCode.UNAVAILABLE,
        'El asistente no está disponible en este momento; reintenta más tarde.',
      );
    } finally {
      clearTimeout(timer);
      await session?.close().catch(() => {});
    }
  }

  private async loop(
    model: ChatModel,
    session: McpSession,
    tools: McpTool[],
    input: AskInput,
    message: string,
    signal: AbortSignal,
    log: Logger,
  ): Promise<AssistantAnswer> {
    const declarations = tools.map(toFunctionDeclaration);
    const toolNames = new Set(tools.map((t) => t.name));
    const contents = toContents(input.history.slice(-this.maxHistoryMessages), message);
    const toolCalls: AssistantToolCall[] = [];

    for (let round = 0; ; round++) {
      const forceText = round >= this.opts.maxRounds;
      const turn = await model.generate({
        contents,
        systemInstruction: SYSTEM_PROMPT,
        functionDeclarations: declarations,
        forceText,
        signal,
      });

      if (forceText || turn.functionCalls.length === 0) {
        log.info(
          {
            model: model.model,
            modelVersion: turn.modelVersion,
            rounds: round,
            toolCalls: toolCalls.length,
          },
          'respuesta del asistente',
        );
        return { message: turn.text.trim() || FALLBACK_MESSAGE, toolCalls };
      }

      if (turn.content) contents.push(turn.content);
      const responses: Part[] = [];
      for (const call of turn.functionCalls) {
        const name = call.name ?? '';
        const args = call.args ?? {};
        let isError: boolean;
        let response: Record<string, unknown>;
        if (!toolNames.has(name)) {
          isError = true;
          response = { error: `La herramienta ${name} no existe.` };
        } else {
          try {
            const result = await session.callTool(name, args);
            isError = result.isError;
            response = isError ? { error: result.text } : { output: result.text };
          } catch (err) {
            if (signal.aborted) throw err;
            log.warn({ err, tool: name }, 'falló la llamada a la tool del MCP');
            isError = true;
            response = { error: 'No se pudo consultar la herramienta en este momento.' };
          }
        }
        toolCalls.push({ name, arguments: JSON.stringify(args), isError });
        responses.push({
          functionResponse: { ...(call.id ? { id: call.id } : {}), name, response },
        });
      }
      contents.push({ role: 'user', parts: responses });
    }
  }

  private count(outcome: string): void {
    this.opts.metrics?.assistantRequests.inc({ outcome });
  }
}
