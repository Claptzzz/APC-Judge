import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { hostHeaderValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import type { AuthInfo, McpHttpHandler } from '@modelcontextprotocol/server';
import { extractBearerToken, InvalidTokenError, PublicKeyUnavailableError } from './auth/jwt.js';
import type { JwtVerifier } from './auth/jwt.js';
import type { Logger } from './logger.js';
import { registerTools } from './tools/tools.js';
import type { Caller } from './tools/tools.js';
import { REQUEST_ID_HEADER } from './upstream/clients.js';
import type { UpstreamClients } from './upstream/clients.js';

export const MCP_PATH = '/mcp';
export const SERVER_INFO = { name: 'juez-mcp', version: '1.0.0' } as const;

const INSTRUCTIONS =
  'Herramientas de solo lectura del juez online de programación competitiva. Todas se ' +
  'ejecutan con la identidad del usuario que conversa: solo ven lo que ese usuario puede ver. ' +
  'Los ids son UUID; si el usuario nombra un problema por su título o slug, búscalo con ' +
  'listar_problemas o ver_problema. Si una tool responde con error, explícale al usuario qué ' +
  'pasó en vez de inventar datos.';

export interface AppOptions {
  verifier: Pick<JwtVerifier, 'verify' | 'hasPublicKey'>;
  clients: UpstreamClients;
  logger: Logger;
  allowedHosts: string[];
  allowedOrigins: string[];
  maxBodyBytes: number;
  upstreamTimeoutMs: number;
}

export interface App {
  server: Server;
  handler: McpHttpHandler;
  /** Cierra el handler MCP (aborta intercambios en curso) y el servidor HTTP. */
  close(): Promise<void>;
}

type AuthedRequest = IncomingMessage & { auth?: AuthInfo };

/** Respuesta de error con forma JSON-RPC, como las que emite el SDK (403/413/415). */
function sendJsonRpcError(
  res: ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  res
    .writeHead(status, { 'content-type': 'application/json', ...headers })
    .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res
    .writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    .end(JSON.stringify(body));
}

function callerFrom(authInfo: AuthInfo | undefined): Caller {
  const extra = authInfo?.extra as Partial<Caller> | undefined;
  if (!authInfo || !extra?.sub || !extra.requestId) {
    // No debería pasar: el gate de autenticación corre antes que el handler MCP.
    throw new Error('request MCP sin identidad autenticada');
  }
  return {
    token: authInfo.token,
    sub: extra.sub,
    username: extra.username ?? '',
    role: extra.role ?? '',
    requestId: extra.requestId,
  };
}

/**
 * Servidor `node:http` con:
 * - `POST /mcp`: MCP Streamable HTTP sin estado (un McpServer por request, sin sesiones),
 *   detrás de la validación de Host/Origin del SDK y de la autenticación Bearer.
 * - `GET /health` (vivo) y `GET /ready` (llave pública de users cargada).
 */
export function createApp(opts: AppOptions): App {
  const { logger } = opts;

  const handler = createMcpHandler(
    ({ authInfo }) => {
      const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
      registerTools(
        server,
        { clients: opts.clients, timeoutMs: opts.upstreamTimeoutMs, logger },
        callerFrom(authInfo),
      );
      return server;
    },
    {
      maxRequestBodySize: opts.maxBodyBytes,
      onerror: (err) => logger.error({ err }, 'error en el handler MCP'),
    },
  );
  const nodeHandler = toNodeHandler(handler, {
    maxRequestBodySize: opts.maxBodyBytes,
    onerror: (err) => logger.error({ err }, 'error en el adaptador HTTP del MCP'),
  });
  // Protección contra DNS rebinding del SDK (403 si Host/Origin no están permitidos).
  const validateHost = hostHeaderValidation(opts.allowedHosts);
  const validateOrigin = originValidation(opts.allowedOrigins);

  async function handleMcp(req: AuthedRequest, res: ServerResponse): Promise<void> {
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;

    const incomingId = req.headers[REQUEST_ID_HEADER];
    const requestId =
      typeof incomingId === 'string' && incomingId.length > 0 && incomingId.length <= 128
        ? incomingId
        : randomUUID();
    res.setHeader(REQUEST_ID_HEADER, requestId);

    let token: string;
    let claims;
    try {
      token = extractBearerToken(req.headers.authorization);
      claims = await opts.verifier.verify(token);
    } catch (err) {
      if (err instanceof InvalidTokenError) {
        logger.info({ requestId, reason: err.message }, 'request MCP rechazado: 401');
        sendJsonRpcError(res, 401, err.message, {
          'www-authenticate': `Bearer realm="juez-mcp", error="invalid_token", error_description="${err.message}"`,
        });
        return;
      }
      if (err instanceof PublicKeyUnavailableError) {
        // users no responde: no es un problema del token, así que no es 401.
        logger.warn({ requestId, err }, 'request MCP rechazado: llave pública no disponible');
        sendJsonRpcError(
          res,
          503,
          'El servicio de usuarios no responde; no se puede verificar el token. Reintenta en unos segundos.',
          { 'retry-after': '5' },
        );
        return;
      }
      throw err;
    }

    req.auth = {
      token,
      clientId: claims.sub,
      scopes: [],
      extra: { sub: claims.sub, username: claims.username, role: claims.role, requestId },
    };
    await nodeHandler(req, res);
  }

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === MCP_PATH) {
      handleMcp(req, res).catch((err: unknown) => {
        logger.error({ err }, 'error inesperado en /mcp');
        if (!res.headersSent) sendJsonRpcError(res, 500, 'Error interno del MCP server');
        else res.end();
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    if (path === '/health') {
      sendJson(res, 200, { status: 'ok' });
    } else if (path === '/ready') {
      const publicKey = opts.verifier.hasPublicKey();
      sendJson(res, publicKey ? 200 : 503, {
        status: publicKey ? 'ok' : 'unavailable',
        checks: { usersPublicKey: publicKey },
      });
    } else {
      sendJson(res, 404, { error: 'not found' });
    }
  });

  return {
    server,
    handler,
    async close() {
      await handler.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
