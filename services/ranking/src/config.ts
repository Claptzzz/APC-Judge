import { z } from 'zod';

// 0 = puerto efímero asignado por el SO (útil en tests).
const port = z.coerce.number().int().min(0).max(65535);
const nonEmpty = z.string().trim().min(1);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  RANKING_HTTP_PORT: port.default(8084),
  RANKING_GRPC_PORT: port.default(50054),
  RANKING_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  RANKING_REDIS_URL: z.url({ protocol: /^rediss?$/ }),

  KAFKA_BROKERS: nonEmpty,
  RANKING_KAFKA_CLIENT_ID: nonEmpty.default('ranking'),
  RANKING_KAFKA_GROUP_ID: nonEmpty.default('ranking'),

  USERS_GRPC_ADDR: nonEmpty,
  PROBLEMS_GRPC_ADDR: nonEmpty,

  JWT_ISSUER: nonEmpty.default('juez-users'),
  JWT_AUDIENCE: nonEmpty.default('juez'),
});

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  logLevel: string;
  httpPort: number;
  grpcPort: number;
  databaseUrl: string;
  redisUrl: string;
  kafka: { brokers: string[]; clientId: string; groupId: string };
  usersBaseUrl: string;
  problemsBaseUrl: string;
  jwt: { issuer: string; audience: string };
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Configuración inválida:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/** `localhost:50052` -> `http://localhost:50052`; una URL con esquema se deja tal cual. */
export function toBaseUrl(addr: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(addr) ? addr : `http://${addr}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`),
    );
  }
  const e = parsed.data;
  const brokers = e.KAFKA_BROKERS.split(',')
    .map((b) => b.trim())
    .filter(Boolean);
  if (brokers.length === 0) throw new ConfigError(['KAFKA_BROKERS: sin brokers']);
  return {
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    httpPort: e.RANKING_HTTP_PORT,
    grpcPort: e.RANKING_GRPC_PORT,
    databaseUrl: e.RANKING_DATABASE_URL,
    redisUrl: e.RANKING_REDIS_URL,
    kafka: { brokers, clientId: e.RANKING_KAFKA_CLIENT_ID, groupId: e.RANKING_KAFKA_GROUP_ID },
    usersBaseUrl: toBaseUrl(e.USERS_GRPC_ADDR),
    problemsBaseUrl: toBaseUrl(e.PROBLEMS_GRPC_ADDR),
    jwt: { issuer: e.JWT_ISSUER, audience: e.JWT_AUDIENCE },
  };
}
