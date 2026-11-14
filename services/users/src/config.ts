import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

// 0 = puerto efímero asignado por el SO (útil en tests).
const port = z.coerce.number().int().min(0).max(65535);
const positiveInt = z.coerce.number().int().positive();
const nonEmpty = z.string().trim().min(1);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    USERS_HTTP_PORT: port.default(8081),
    USERS_GRPC_PORT: port.default(50051),
    USERS_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),

    KAFKA_BROKERS: nonEmpty,
    USERS_KAFKA_CLIENT_ID: nonEmpty.default('users'),
    USERS_OUTBOX_POLL_INTERVAL_MS: positiveInt.default(500),
    USERS_OUTBOX_BATCH_SIZE: positiveInt.max(1000).default(100),

    JWT_PRIVATE_KEY_PATH: nonEmpty,
    JWT_PUBLIC_KEY_PATH: nonEmpty.optional(),
    JWT_KEY_ID: nonEmpty.default('dev-1'),
    JWT_ISSUER: nonEmpty.default('juez-users'),
    JWT_AUDIENCE: nonEmpty.default('juez'),
    JWT_TTL_SECONDS: positiveInt.default(3600),

    // Admin inicial (opcional): las tres o ninguna.
    USERS_ADMIN_USERNAME: nonEmpty.optional(),
    USERS_ADMIN_EMAIL: nonEmpty.optional(),
    USERS_ADMIN_PASSWORD: nonEmpty.optional(),
  })
  .superRefine((env, ctx) => {
    const admin = [env.USERS_ADMIN_USERNAME, env.USERS_ADMIN_EMAIL, env.USERS_ADMIN_PASSWORD];
    const defined = admin.filter((v) => v !== undefined).length;
    if (defined !== 0 && defined !== admin.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['USERS_ADMIN_USERNAME'],
        message: 'USERS_ADMIN_USERNAME, USERS_ADMIN_EMAIL y USERS_ADMIN_PASSWORD van juntas',
      });
    }
  });

export interface AdminBootstrap {
  username: string;
  email: string;
  password: string;
}

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  logLevel: string;
  httpPort: number;
  grpcPort: number;
  databaseUrl: string;
  kafka: { brokers: string[]; clientId: string };
  outbox: { pollIntervalMs: number; batchSize: number };
  jwt: {
    privateKeyPath: string;
    publicKeyPath: string | undefined;
    keyId: string;
    issuer: string;
    audience: string;
    ttlSeconds: number;
  };
  admin: AdminBootstrap | undefined;
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Configuración inválida:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Resuelve una ruta de archivo. Las relativas se buscan desde `cwd` y, si no existen ahí,
 * desde la raíz del workspace (el primer ancestro con pnpm-workspace.yaml): así
 * `.secrets/jwt-private.pem` funciona tanto desde la raíz como desde services/users.
 */
export function resolveFilePath(path: string, cwd: string = process.cwd()): string {
  if (isAbsolute(path)) return path;
  const fromCwd = resolve(cwd, path);
  if (existsSync(fromCwd)) return fromCwd;
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return resolve(dir, path);
    const parent = dirname(dir);
    if (parent === dir) return fromCwd;
    dir = parent;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd?: string): Config {
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
    httpPort: e.USERS_HTTP_PORT,
    grpcPort: e.USERS_GRPC_PORT,
    databaseUrl: e.USERS_DATABASE_URL,
    kafka: {
      brokers: e.KAFKA_BROKERS.split(',')
        .map((b) => b.trim())
        .filter(Boolean),
      clientId: e.USERS_KAFKA_CLIENT_ID,
    },
    outbox: {
      pollIntervalMs: e.USERS_OUTBOX_POLL_INTERVAL_MS,
      batchSize: e.USERS_OUTBOX_BATCH_SIZE,
    },
    jwt: {
      privateKeyPath: resolveFilePath(e.JWT_PRIVATE_KEY_PATH, cwd),
      publicKeyPath: e.JWT_PUBLIC_KEY_PATH
        ? resolveFilePath(e.JWT_PUBLIC_KEY_PATH, cwd)
        : undefined,
      keyId: e.JWT_KEY_ID,
      issuer: e.JWT_ISSUER,
      audience: e.JWT_AUDIENCE,
      ttlSeconds: e.JWT_TTL_SECONDS,
    },
    admin:
      e.USERS_ADMIN_USERNAME && e.USERS_ADMIN_EMAIL && e.USERS_ADMIN_PASSWORD
        ? {
            username: e.USERS_ADMIN_USERNAME,
            email: e.USERS_ADMIN_EMAIL,
            password: e.USERS_ADMIN_PASSWORD,
          }
        : undefined,
  };
}
