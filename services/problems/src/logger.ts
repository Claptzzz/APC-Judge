import { pino, type Logger } from 'pino';

export const SERVICE_NAME = 'problems';

export type { Logger };

/** Logger JSON (pino) con el nombre del servicio en cada línea. */
export function createLogger(level: string): Logger {
  return pino({
    name: SERVICE_NAME,
    level,
    base: { service: SERVICE_NAME },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  });
}
