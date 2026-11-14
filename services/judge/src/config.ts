import { z } from 'zod';

const port = z.coerce.number().int().min(1).max(65_535);
const positiveInt = z.coerce.number().int().positive();

/** Variables de entorno del judge (ficha `services/judge/README.md` y `.env.example`). */
export const envSchema = z.object({
  JUDGE_HTTP_PORT: port.default(8085),
  KAFKA_BROKERS: z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((broker) => broker.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string()).min(1, 'KAFKA_BROKERS no tiene brokers')),
  JUDGE_KAFKA_CLIENT_ID: z.string().min(1).default('judge'),
  JUDGE_KAFKA_GROUP_ID: z.string().min(1).default('judge'),
  PROBLEMS_GRPC_ADDR: z.string().min(1),
  // Se valida, pero el judge procesa un mensaje a la vez por instancia (escala por réplicas).
  JUDGE_CONCURRENCY: positiveInt.default(1),
  JUDGE_WORKDIR: z.string().min(1).default('/tmp/juez-judge'),
  JUDGE_COMPILE_TIMEOUT_MS: positiveInt.default(10_000),
  JUDGE_MAX_OUTPUT_KB: positiveInt.default(65_536),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

export interface Config {
  httpPort: number;
  kafka: { brokers: string[]; clientId: string; groupId: string };
  /** baseUrl del cliente Connect hacia problems (`http://host:port`). */
  problemsBaseUrl: string;
  concurrency: number;
  workdir: string;
  compileTimeoutMs: number;
  maxOutputBytes: number;
  logLevel: Env['LOG_LEVEL'];
}

/** `localhost:50052` -> `http://localhost:50052`; una URL con esquema se deja tal cual. */
export function toBaseUrl(addr: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(addr) ? addr : `http://${addr}`;
}

/** Lee y valida la configuración. Lanza un error con todas las variables inválidas. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(env)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Configuración inválida: ${issues}`);
  }
  const e = parsed.data;
  return {
    httpPort: e.JUDGE_HTTP_PORT,
    kafka: {
      brokers: e.KAFKA_BROKERS,
      clientId: e.JUDGE_KAFKA_CLIENT_ID,
      groupId: e.JUDGE_KAFKA_GROUP_ID,
    },
    problemsBaseUrl: toBaseUrl(e.PROBLEMS_GRPC_ADDR),
    concurrency: e.JUDGE_CONCURRENCY,
    workdir: e.JUDGE_WORKDIR,
    compileTimeoutMs: e.JUDGE_COMPILE_TIMEOUT_MS,
    maxOutputBytes: e.JUDGE_MAX_OUTPUT_KB * 1024,
    logLevel: e.LOG_LEVEL,
  };
}
