import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';

export interface McpTool {
  name: string;
  description?: string | undefined;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  isError: boolean;
  /** Texto compacto pensado para el LLM (los bloques `text` de la respuesta). */
  text: string;
}

/** Conexión al MCP server con la identidad de un usuario (una por pregunta). */
export interface McpSession {
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
  close(): Promise<void>;
}

export interface McpConnectOptions {
  token: string;
  requestId: string;
  signal: AbortSignal;
}

export interface McpConnector {
  connect(opts: McpConnectOptions): Promise<McpSession>;
}

const MAX_TOOL_PAGES = 5;

function resultText(result: CallToolResult): string {
  const text = (result.content ?? [])
    .filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  if (text) return text;
  return result.structuredContent ? JSON.stringify(result.structuredContent) : '';
}

/**
 * Cliente MCP v2 (`@modelcontextprotocol/client`, Streamable HTTP) hacia `MCP_URL`. Envía el
 * JWT del usuario en `Authorization` y el `x-request-id` en cada request. El MCP server es
 * sin estado, así que cada pregunta abre su propia conexión y la cierra al terminar.
 */
export class HttpMcpConnector implements McpConnector {
  constructor(
    private readonly url: string,
    private readonly requestTimeoutMs = 10_000,
  ) {}

  async connect({ token, requestId, signal }: McpConnectOptions): Promise<McpSession> {
    const client = new Client(
      { name: 'juez-bff', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: { headers: { Authorization: `Bearer ${token}`, 'x-request-id': requestId } },
    });
    const opts = { signal, timeout: this.requestTimeoutMs };
    try {
      await client.connect(transport, opts);
    } catch (err) {
      await client.close().catch(() => {});
      throw err;
    }

    return {
      listTools: async () => {
        const tools: McpTool[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < MAX_TOOL_PAGES; page++) {
          const res = await client.listTools(cursor ? { cursor } : undefined, opts);
          for (const t of res.tools) {
            tools.push({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema as Record<string, unknown>,
            });
          }
          cursor = res.nextCursor;
          if (!cursor) break;
        }
        return tools;
      },
      callTool: async (name, args) => {
        const result = (await client.callTool({ name, arguments: args }, opts)) as CallToolResult;
        return { isError: result.isError === true, text: resultText(result) };
      },
      close: () => client.close(),
    };
  }
}
