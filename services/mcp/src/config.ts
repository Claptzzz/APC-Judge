import { z } from 'zod';

const port = z.coerce.number().int().min(0).max(65_535);
const positiveInt = z.coerce.number().int().positive();
const nonEmpty = z.string().trim().min(1);

/** Lista separada por comas → array sin vacíos. */
const csv = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
);

/** Variables de entorno del MCP server (ficha `services/mcp/README.md` y `.env.example`). */
export const envSchema = z.object({
  MCP_PORT: port.default(4100),
  /** Dirección de escucha del servidor HTTP. */
  MCP_HOST: nonEmpty.default('0.0.0.0'),
  /**
   * Hostnames (sin puerto) aceptados en el header `Host` de /mcp: protección contra DNS
   * rebinding del SDK. En docker/k8s agrega el nombre del servicio (p. ej. `mcp`).
   */
  MCP_ALLOWED_HOSTS: csv.default(['localhost', '127.0.0.1', '[::1]']),
  /**
   * Hostnames aceptados en el header `Origin` de /mcp (p. ej. `app.example.com`). Vacío (por
   * defecto) = se rechaza cualquier request que traiga `Origin` (un navegador): el único
   * cliente es el BFF, que llama desde el servidor sin `Origin`.
   */
  MCP_ALLOWED_ORIGINS: csv.default([]),
  /** Límite del body de /mcp en bytes (413 por encima). */
  MCP_MAX_BODY_BYTES: positiveInt.default(256 * 1024),
  /** Timeout por llamada a los servicios gRPC. */
  MCP_UPSTREAM_TIMEOUT_MS: positiveInt.default(3_000),

  USERS_GRPC_ADDR: nonEmpty.default('localhost:50051'),
  PROBLEMS_GRPC_ADDR: nonEmpty.default('localhost:50052'),
  SUBMISSIONS_GRPC_ADDR: nonEmpty.default('localhost:50053'),
  RANKING_GRPC_ADDR: nonEmpty.default('localhost:50054'),

  JWT_ISSUER: nonEmpty.default('juez-users'),
  JWT_AUDIENCE: nonEmpty.default('juez'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export interface Config {
  port: number;
  host: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  maxBodyBytes: number;
  upstreamTimeoutMs: number;
  /** baseUrl de los clientes Connect (`http://host:port`). */
  baseUrls: { users: string; problems: string; submissions: string; ranking: string };
  jwt: { issuer: string; audience: string };
  logLevel: z.infer<typeof envSchema>['LOG_LEVEL'];
}

export class ConfigError extends Error {
  override name = 'ConfigError';
  constructor(readonly issues: string[]) {
    super(`Configuración inválida: ${issues.join('; ')}`);
  }
}

/** `localhost:50052` → `http://localhost:50052`; una URL con esquema se deja tal cual. */
export function toBaseUrl(addr: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(addr) ? addr : `http://${addr}`;
}

/** Lee y valida la configuración. Lanza ConfigError con todas las variables inválidas. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(env)'}: ${issue.message}`),
    );
  }
  const e = parsed.data;
  return {
    port: e.MCP_PORT,
    host: e.MCP_HOST,
    allowedHosts: e.MCP_ALLOWED_HOSTS,
    allowedOrigins: e.MCP_ALLOWED_ORIGINS,
    maxBodyBytes: e.MCP_MAX_BODY_BYTES,
    upstreamTimeoutMs: e.MCP_UPSTREAM_TIMEOUT_MS,
    baseUrls: {
      users: toBaseUrl(e.USERS_GRPC_ADDR),
      problems: toBaseUrl(e.PROBLEMS_GRPC_ADDR),
      submissions: toBaseUrl(e.SUBMISSIONS_GRPC_ADDR),
      ranking: toBaseUrl(e.RANKING_GRPC_ADDR),
    },
    jwt: { issuer: e.JWT_ISSUER, audience: e.JWT_AUDIENCE },
    logLevel: e.LOG_LEVEL,
  };
}
