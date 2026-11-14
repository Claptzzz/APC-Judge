import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';
import type { GrpcOptions } from '@nestjs/microservices';
import { PROTO_PACKAGES, PROTO_ROOT, protoPath } from '@juez/contracts/proto';
import { AppModule } from './app.module.js';
import { ConfigError, loadConfig } from './config.js';
import { createLogger } from './logger.js';

async function bootstrap() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      createLogger('error').fatal({ issues: err.issues }, 'configuración inválida');
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger(config.logLevel);

  process.on('unhandledRejection', (err) => {
    logger.fatal({ err }, 'unhandledRejection');
    process.exit(1);
  });

  try {
    const app = await NestFactory.create(AppModule.register(config), {
      abortOnError: false,
    });

    app.enableShutdownHooks();

    // Conectar microservicio gRPC nativo
    app.connectMicroservice<GrpcOptions>({
      transport: Transport.GRPC,
      options: {
        package: PROTO_PACKAGES.submissions,
        protoPath: protoPath('submissions'),
        loader: {
          includeDirs: [PROTO_ROOT],
        },
        url: `0.0.0.0:${config.grpcPort}`,
      },
    });

    await app.startAllMicroservices();
    await app.listen(config.httpPort, '0.0.0.0');

    logger.info(
      {
        httpPort: config.httpPort,
        grpcPort: config.grpcPort,
      },
      'submissions listo',
    );
  } catch (err) {
    logger.fatal({ err }, 'no se pudo arrancar submissions');
    process.exit(1);
  }
}

void bootstrap();
