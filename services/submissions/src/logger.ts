import { pino } from 'pino';
import type { Logger } from 'pino';

export const SERVICE_NAME = 'submissions';

export type { Logger };

/** Logger JSON con el nombre del servicio en cada línea. */
export function createLogger(level: string, destination?: pino.DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: SERVICE_NAME },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: {
        paths: ['authorization', '*.authorization'],
        censor: '[redacted]',
      },
    },
    destination,
  );
}
