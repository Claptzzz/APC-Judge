import { z } from 'zod';

const port = z.coerce.number().int().min(0).max(65535);
const positiveInt = z.coerce.number().int().positive();
const nonEmpty = z.string().trim().min(1);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  SUBMISSIONS_HTTP_PORT: port.default(8083),
  SUBMISSIONS_GRPC_PORT: port.default(50053),
  SUBMISSIONS_DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'URL de Postgres inválida'),

  KAFKA_BROKERS: nonEmpty,
  SUBMISSIONS_KAFKA_CLIENT_ID: nonEmpty.default('submissions'),
  SUBMISSIONS_KAFKA_GROUP_ID: nonEmpty.default('submissions'),
  SUBMISSIONS_OUTBOX_POLL_INTERVAL_MS: positiveInt.default(500),
  SUBMISSIONS_OUTBOX_BATCH_SIZE: positiveInt.max(1000).default(100),

  USERS_GRPC_ADDR: nonEmpty.default('localhost:50051'),
  PROBLEMS_GRPC_ADDR: nonEmpty.default('localhost:50052'),
  RANKING_GRPC_ADDR: nonEmpty.default('localhost:50054'),

  JWT_ISSUER: nonEmpty.default('juez-users'),
  JWT_AUDIENCE: nonEmpty.default('juez'),
});

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  logLevel: string;
  httpPort: number;
  grpcPort: number;
  databaseUrl: string;
  kafka: {
    brokers: string[];
    clientId: string;
    groupId: string;
  };
  outbox: {
    pollIntervalMs: number;
    batchSize: number;
  };
  grpcAddrs: {
    users: string;
    problems: string;
    ranking: string;
  };
  jwt: {
    issuer: string;
    audience: string;
  };
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Configuración inválida:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
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
    httpPort: e.SUBMISSIONS_HTTP_PORT,
    grpcPort: e.SUBMISSIONS_GRPC_PORT,
    databaseUrl: e.SUBMISSIONS_DATABASE_URL,
    kafka: {
      brokers: e.KAFKA_BROKERS.split(',')
        .map((b) => b.trim())
        .filter(Boolean),
      clientId: e.SUBMISSIONS_KAFKA_CLIENT_ID,
      groupId: e.SUBMISSIONS_KAFKA_GROUP_ID,
    },
    outbox: {
      pollIntervalMs: e.SUBMISSIONS_OUTBOX_POLL_INTERVAL_MS,
      batchSize: e.SUBMISSIONS_OUTBOX_BATCH_SIZE,
    },
    grpcAddrs: {
      users: e.USERS_GRPC_ADDR,
      problems: e.PROBLEMS_GRPC_ADDR,
      ranking: e.RANKING_GRPC_ADDR,
    },
    jwt: {
      issuer: e.JWT_ISSUER,
      audience: e.JWT_AUDIENCE,
    },
  };
}
