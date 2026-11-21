import { pino } from 'pino';
import type { Logger } from 'pino';

export type { Logger };

export const SERVICE_NAME = 'mcp';

/** Logger JSON (pino) con el nombre del servicio. */
export function createLogger(level: string = 'info'): Logger {
  return pino({ name: SERVICE_NAME, level });
}
