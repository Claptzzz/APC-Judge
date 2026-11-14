import { pino } from 'pino';
import type { Logger } from 'pino';

export const SERVICE_NAME = 'users';

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
        paths: ['password', '*.password', 'passwordHash', '*.passwordHash', 'authorization'],
        censor: '[redacted]',
      },
    },
    destination,
  );
}
