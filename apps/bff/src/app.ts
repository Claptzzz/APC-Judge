import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import type { AppDeps } from './app.module.js';
import { PinoNestLogger } from './logger.js';

/** Crea la aplicación Nest (sin escuchar todavía). Se usa en main.ts y en los tests. */
export async function createApp(deps: AppDeps): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(deps), {
    logger: new PinoNestLogger(deps.logger.child({ component: 'nest' })),
    abortOnError: false,
  });
  app.enableCors({
    origin: deps.config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
  });
  // Enunciados de hasta 100.000 caracteres y código de hasta 64 KiB.
  app.useBodyParser('json', { limit: '1mb' });
  app.enableShutdownHooks();
  return app;
}
