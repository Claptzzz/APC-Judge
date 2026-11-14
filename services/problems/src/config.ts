import { z } from 'zod';

const port = z.coerce.number().int().min(1).max(65_535);
const httpUrl = z.url({ protocol: /^https?$/ });

const dbSchema = z.object({
  PROBLEMS_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
});

const s3Schema = z.object({
  /** Endpoint interno (red de servicios): lo usa problems y con él se firman las URLs del judge. */
  S3_ENDPOINT: httpUrl,
  /** Endpoint público: con él se firman las URLs de subida que usa el navegador. */
  S3_PUBLIC_ENDPOINT: httpUrl,
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_FORCE_PATH_STYLE: z.stringbool().default(true),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_BUCKET_TESTCASES: z.string().min(1).default('testcases'),
  /** Vigencia de las URLs PUT de subida (CreateTestcaseUploadUrl). */
  S3_PRESIGN_TTL_SECONDS: z.coerce.number().int().min(60).max(604_800).default(900),
  /** Vigencia de las URLs GET del judge (GetJudgeSpec): corta, ~10 min. */
  S3_JUDGE_PRESIGN_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(600),
});

const commonSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export const configSchema = commonSchema
  .extend(dbSchema.shape)
  .extend(s3Schema.shape)
  .extend({
    PROBLEMS_HTTP_PORT: port.default(8082),
    PROBLEMS_GRPC_PORT: port.default(50052),
    USERS_GRPC_ADDR: z.string().min(1),
    JWT_ISSUER: z.string().min(1),
    JWT_AUDIENCE: z.string().min(1),
  });

/** Subconjunto que necesitan los scripts `db:migrate` y `db:seed`. */
export const migrateConfigSchema = commonSchema.extend(dbSchema.shape);
export const seedConfigSchema = commonSchema.extend(dbSchema.shape).extend(s3Schema.shape);

export type Config = z.infer<typeof configSchema>;
export type MigrateConfig = z.infer<typeof migrateConfigSchema>;
export type SeedConfig = z.infer<typeof seedConfigSchema>;
export type S3Config = z.infer<typeof s3Schema>;

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** Valida las variables de entorno; lanza ConfigError con un resumen legible si fallan. */
export function parseConfig<S extends z.ZodType>(
  schema: S,
  env: Record<string, string | undefined>,
): z.infer<S> {
  // Las variables vacías (`FOO=`) cuentan como ausentes, para que apliquen los defaults.
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ''),
  );
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(raíz)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`configuración inválida: ${detail}`);
  }
  return result.data;
}

export const loadConfig = (env: Record<string, string | undefined> = process.env): Config =>
  parseConfig(configSchema, env);

/** Normaliza `host:port` a URL base para un cliente Connect (acepta también una URL completa). */
export function grpcBaseUrl(addr: string): string {
  return /^https?:\/\//.test(addr) ? addr : `http://${addr}`;
}
