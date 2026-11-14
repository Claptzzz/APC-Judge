import { pino } from 'pino';
import type { Logger } from 'pino';

export type { Logger };

export const SERVICE_NAME = 'judge';

/** Logger JSON (pino) con el nombre del servicio. */
export function createLogger(level: string = 'info'): Logger {
  return pino({ name: SERVICE_NAME, level });
}
