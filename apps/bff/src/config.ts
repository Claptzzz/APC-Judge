import { hostname } from 'node:os';
import { z } from 'zod';

const port = z.coerce.number().int().min(0).max(65535);
const positiveInt = z.coerce.number().int().positive();
const nonEmpty = z.string().trim().min(1);
/** Variable opcional: vacía (`GEMINI_API_KEY=` en .env.example) equivale a no definida. */
const optionalText = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : undefined));
const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  BFF_PORT: port.default(4000),
  BFF_CORS_ORIGIN: nonEmpty.default('http://localhost:5173'),

  USERS_GRPC_ADDR: nonEmpty.default('localhost:50051'),
  PROBLEMS_GRPC_ADDR: nonEmpty.default('localhost:50052'),
  SUBMISSIONS_GRPC_ADDR: nonEmpty.default('localhost:50053'),
  RANKING_GRPC_ADDR: nonEmpty.default('localhost:50054'),

  KAFKA_BROKERS: nonEmpty,
  BFF_KAFKA_CLIENT_ID: nonEmpty.default('bff'),
  BFF_KAFKA_GROUP_ID: nonEmpty.default('bff'),

  JWT_ISSUER: nonEmpty.default('juez-users'),
  JWT_AUDIENCE: nonEmpty.default('juez'),

  MCP_URL: z.url().default('http://localhost:4100/mcp'),

  GOOGLE_GENAI_USE_VERTEXAI: bool,
  GEMINI_API_KEY: optionalText,
  GOOGLE_CLOUD_PROJECT: optionalText,
  GOOGLE_CLOUD_LOCATION: optionalText,
  GEMINI_MODEL: nonEmpty.default('gemini-3.8-flash'),

  // Opcionales propias del BFF (no están en .env.example; ver la ficha).
  BFF_GRPC_TIMEOUT_MS: positiveInt.default(3000),
  BFF_GRAPHQL_MAX_DEPTH: positiveInt.default(10),
  BFF_ASSISTANT_RATE_LIMIT_PER_MINUTE: positiveInt.default(10),
  BFF_ASSISTANT_TIMEOUT_MS: positiveInt.default(30_000),
  BFF_ASSISTANT_MAX_ROUNDS: positiveInt.max(20).default(5),
});

/** Cómo se autentica el BFF contra Gemini; `undefined` = asistente deshabilitado. */
export type GeminiAuth =
  { mode: 'api-key'; apiKey: string } | { mode: 'vertex'; project: string; location: string };

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  logLevel: string;
  port: number;
  corsOrigins: string[];
  grpc: {
    users: string;
    problems: string;
    submissions: string;
    ranking: string;
    timeoutMs: number;
  };
  kafka: {
    brokers: string[];
    clientId: string;
    /** Group id efectivo: prefijo + hostname (único por réplica). */
    groupId: string;
  };
  jwt: { issuer: string; audience: string };
  graphql: { maxDepth: number; introspection: boolean };
  assistant: {
    mcpUrl: string;
    model: string;
    gemini: GeminiAuth | undefined;
    /** Por qué está deshabilitado (para el log de arranque). */
    disabledReason: string | undefined;
    rateLimitPerMinute: number;
    timeoutMs: number;
    maxRounds: number;
  };
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Configuración inválida:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function geminiAuth(e: z.infer<typeof envSchema>): {
  gemini: GeminiAuth | undefined;
  disabledReason: string | undefined;
} {
  if (e.GOOGLE_GENAI_USE_VERTEXAI) {
    if (!e.GOOGLE_CLOUD_PROJECT || !e.GOOGLE_CLOUD_LOCATION) {
      return {
        gemini: undefined,
        disabledReason:
          'GOOGLE_GENAI_USE_VERTEXAI=true requiere GOOGLE_CLOUD_PROJECT y GOOGLE_CLOUD_LOCATION',
      };
    }
    return {
      gemini: {
        mode: 'vertex',
        project: e.GOOGLE_CLOUD_PROJECT,
        location: e.GOOGLE_CLOUD_LOCATION,
      },
      disabledReason: undefined,
    };
  }
  if (!e.GEMINI_API_KEY) {
    return {
      gemini: undefined,
      disabledReason: 'falta GEMINI_API_KEY (o GOOGLE_GENAI_USE_VERTEXAI=true con Vertex AI)',
    };
  }
  return { gemini: { mode: 'api-key', apiKey: e.GEMINI_API_KEY }, disabledReason: undefined };
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  host: string = hostname(),
): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`),
    );
  }
  const e = parsed.data;
  return {
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    port: e.BFF_PORT,
    corsOrigins: splitList(e.BFF_CORS_ORIGIN),
    grpc: {
      users: e.USERS_GRPC_ADDR,
      problems: e.PROBLEMS_GRPC_ADDR,
      submissions: e.SUBMISSIONS_GRPC_ADDR,
      ranking: e.RANKING_GRPC_ADDR,
      timeoutMs: e.BFF_GRPC_TIMEOUT_MS,
    },
    kafka: {
      brokers: splitList(e.KAFKA_BROKERS),
      clientId: e.BFF_KAFKA_CLIENT_ID,
      groupId: `${e.BFF_KAFKA_GROUP_ID}-${host}`,
    },
    jwt: { issuer: e.JWT_ISSUER, audience: e.JWT_AUDIENCE },
    graphql: { maxDepth: e.BFF_GRAPHQL_MAX_DEPTH, introspection: e.NODE_ENV !== 'production' },
    assistant: {
      mcpUrl: e.MCP_URL,
      model: e.GEMINI_MODEL,
      ...geminiAuth(e),
      rateLimitPerMinute: e.BFF_ASSISTANT_RATE_LIMIT_PER_MINUTE,
      timeoutMs: e.BFF_ASSISTANT_TIMEOUT_MS,
      maxRounds: e.BFF_ASSISTANT_MAX_ROUNDS,
    },
  };
}
