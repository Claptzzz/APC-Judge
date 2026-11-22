// HttpMcpConnector contra un MCP server v2 real (sin estado) en un puerto local.
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HttpMcpConnector } from './mcp.js';

let server: Server;
let url: string;
const seenHeaders: IncomingHttpHeaders[] = [];

beforeAll(async () => {
  const handler = createMcpHandler(() => {
    const mcp = new McpServer({ name: 'mcp-de-prueba', version: '1.0.0' });
    mcp.registerTool(
      'ver_submission',
      {
        description: 'Detalle de una submission',
        inputSchema: z.object({ id: z.string() }),
        annotations: { readOnlyHint: true },
      },
      async ({ id }) =>
        id === 'nope'
          ? { content: [{ type: 'text', text: `La submission ${id} no existe.` }], isError: true }
          : { content: [{ type: 'text', text: `Submission ${id}: WRONG_ANSWER (2/3 casos)` }] },
    );
    mcp.registerTool(
      'solo_estructura',
      { description: 'Sin texto', inputSchema: z.object({}) },
      async () => ({ content: [], structuredContent: { ok: true } }),
    );
    return mcp;
  });
  const node = toNodeHandler(handler);
  server = createServer((req, res) => {
    seenHeaders.push(req.headers);
    if (req.headers.authorization !== 'Bearer jwt-de-alice') {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    void node(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('HttpMcpConnector', () => {
  it('lista las tools y las llama con el token del usuario y x-request-id', async () => {
    const connector = new HttpMcpConnector(url);
    const session = await connector.connect({
      token: 'jwt-de-alice',
      requestId: 'req-42',
      signal: new AbortController().signal,
    });
    try {
      const tools = await session.listTools();
      expect(tools.map((t) => t.name)).toEqual(['ver_submission', 'solo_estructura']);
      expect(tools[0]!.inputSchema).toMatchObject({
        type: 'object',
        properties: { id: { type: 'string' } },
      });

      expect(await session.callTool('ver_submission', { id: 's1' })).toEqual({
        isError: false,
        text: 'Submission s1: WRONG_ANSWER (2/3 casos)',
      });
      expect(await session.callTool('ver_submission', { id: 'nope' })).toEqual({
        isError: true,
        text: 'La submission nope no existe.',
      });
      expect(await session.callTool('solo_estructura', {})).toEqual({
        isError: false,
        text: '{"ok":true}',
      });
    } finally {
      await session.close();
    }
    expect(seenHeaders.length).toBeGreaterThan(0);
    for (const h of seenHeaders) {
      expect(h.authorization).toBe('Bearer jwt-de-alice');
      expect(h['x-request-id']).toBe('req-42');
    }
  });

  it('falla al conectar si el MCP rechaza el token', async () => {
    const connector = new HttpMcpConnector(url);
    await expect(
      connector.connect({
        token: 'otro',
        requestId: 'r',
        signal: new AbortController().signal,
      }),
    ).rejects.toBeDefined();
  });

  it('falla al conectar si el MCP no responde', async () => {
    const connector = new HttpMcpConnector('http://127.0.0.1:1/mcp', 1000);
    await expect(
      connector.connect({ token: 't', requestId: 'r', signal: new AbortController().signal }),
    ).rejects.toBeDefined();
  });
});
