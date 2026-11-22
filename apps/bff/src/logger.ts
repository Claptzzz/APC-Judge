import type { LoggerService } from '@nestjs/common';
import { pino } from 'pino';
import type { Logger } from 'pino';

export const SERVICE_NAME = 'bff';

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
        paths: [
          'authorization',
          '*.authorization',
          'req.headers.authorization',
          'connectionParams.authorization',
          'password',
          '*.password',
        ],
        censor: '[redacted]',
      },
    },
    destination,
  );
}

/** Adaptador para que los logs internos de Nest también salgan en JSON por pino. */
export class PinoNestLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  private write(
    level: 'info' | 'warn' | 'error' | 'debug' | 'trace',
    message: unknown,
    params: unknown[],
  ) {
    const context = typeof params.at(-1) === 'string' ? (params.at(-1) as string) : undefined;
    const extra = context ? params.slice(0, -1) : params;
    const stack = extra.find((p) => typeof p === 'string');
    this.logger[level]({ context, ...(stack ? { stack } : {}) }, String(message));
  }

  log(message: unknown, ...params: unknown[]) {
    this.write('info', message, params);
  }
  error(message: unknown, ...params: unknown[]) {
    this.write('error', message, params);
  }
  warn(message: unknown, ...params: unknown[]) {
    this.write('warn', message, params);
  }
  debug(message: unknown, ...params: unknown[]) {
    this.write('debug', message, params);
  }
  verbose(message: unknown, ...params: unknown[]) {
    this.write('trace', message, params);
  }
}
