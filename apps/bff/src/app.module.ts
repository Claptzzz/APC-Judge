import { ApolloDriver } from '@nestjs/apollo';
import type { ApolloDriverConfig } from '@nestjs/apollo';
import { Inject, Module } from '@nestjs/common';
import type { DynamicModule, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { GraphQLModule } from '@nestjs/graphql';
import { GRAPHQL_SCHEMA_PATH } from '@juez/contracts/graphql';
import type { GraphQLFormattedError } from 'graphql';
import type { AssistantService } from './assistant/assistant.service.js';
import type { JwtVerifier } from './auth/jwt-verifier.js';
import type { Config } from './config.js';
import type { JudgedEvent } from './events/judged.js';
import type { PubSub } from './events/pubsub.js';
import { ContextFactory } from './graphql/context.js';
import { depthLimitRule } from './graphql/depth-limit.js';
import { PassthroughGqlExceptionFilter } from './graphql/exception.filter.js';
import { AssistantResolver } from './graphql/resolvers/assistant.resolver.js';
import {
  ContestProblemFieldsResolver,
  ContestsResolver,
} from './graphql/resolvers/contests.resolver.js';
import { ProblemsResolver } from './graphql/resolvers/problems.resolver.js';
import {
  SubmissionFieldsResolver,
  SubmissionsResolver,
} from './graphql/resolvers/submissions.resolver.js';
import { SubscriptionsResolver } from './graphql/resolvers/subscriptions.resolver.js';
import { UsersResolver } from './graphql/resolvers/users.resolver.js';
import { DateTimeScalar } from './graphql/scalars.js';
import type { Backend } from './grpc/backend.js';
import { ErrorCode } from './grpc/errors.js';
import { HealthController } from './health/health.controller.js';
import type { ConsumerHandle } from './kafka/judged.consumer.js';
import type { Logger } from './logger.js';
import type { Metrics } from './metrics.js';
import {
  ASSISTANT,
  BACKEND,
  CONFIG,
  CONSUMER,
  LOGGER,
  METRICS,
  PUBSUB,
  VERIFIER,
} from './tokens.js';

/** Dependencias ya construidas (main.ts usa las reales; los tests, dobles). */
export interface AppDeps {
  config: Config;
  logger: Logger;
  metrics: Metrics;
  backend: Backend;
  verifier: Pick<JwtVerifier, 'verify' | 'hasPublicKey' | 'init' | 'stop'>;
  pubsub: PubSub<JudgedEvent>;
  assistant: Pick<AssistantService, 'ask'>;
  consumer: ConsumerHandle;
  /** Cierra los clientes gRPC al apagar. */
  closeBackend?: () => Promise<void>;
}

const KNOWN_CODES = new Set<string>([
  ...Object.values(ErrorCode),
  'GRAPHQL_PARSE_FAILED',
  'GRAPHQL_VALIDATION_FAILED',
  'BAD_REQUEST',
  'PERSISTED_QUERY_NOT_FOUND',
  'PERSISTED_QUERY_NOT_SUPPORTED',
  'OPERATION_RESOLUTION_FAILURE',
]);

/** Oculta el mensaje de errores inesperados (no los que el BFF arma a propósito). */
export function formatError(logger: Logger, production: boolean) {
  return (formatted: GraphQLFormattedError, error: unknown): GraphQLFormattedError => {
    const code = formatted.extensions?.code;
    if (typeof code === 'string' && KNOWN_CODES.has(code) && code !== 'INTERNAL_SERVER_ERROR') {
      return formatted;
    }
    const original = (error as { originalError?: unknown })?.originalError ?? error;
    const intentional =
      code === 'INTERNAL_SERVER_ERROR' &&
      (original as { extensions?: { code?: unknown } })?.extensions?.code === code;
    if (!intentional) logger.error({ err: original, path: formatted.path }, 'error inesperado');
    return {
      message: intentional ? formatted.message : 'Error interno del servidor.',
      ...(formatted.locations && { locations: formatted.locations }),
      ...(formatted.path && { path: formatted.path }),
      extensions: {
        code: 'INTERNAL_SERVER_ERROR',
        ...(!production && formatted.extensions?.stacktrace
          ? { stacktrace: formatted.extensions.stacktrace }
          : {}),
      },
    };
  };
}

interface HttpContextArg {
  req: { headers: Record<string, string | string[] | undefined> };
}
interface WsContextArg {
  connectionParams?: Readonly<Record<string, unknown>> | undefined;
}

@Module({})
export class AppModule implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(VERIFIER) private readonly verifier: AppDeps['verifier'],
    @Inject(CONSUMER) private readonly consumer: AppDeps['consumer'],
    @Inject('CLOSE_BACKEND') private readonly closeBackend: () => Promise<void>,
  ) {}

  static forRoot(deps: AppDeps): DynamicModule {
    const { config, logger } = deps;
    const contexts = new ContextFactory(deps.verifier, deps.backend, logger);
    const production = config.nodeEnv === 'production';

    const graphql = GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      typePaths: [GRAPHQL_SCHEMA_PATH],
      resolvers: { DateTime: DateTimeScalar },
      path: '/graphql',
      introspection: config.graphql.introspection,
      graphiql: config.graphql.introspection,
      includeStacktraceInErrorResponses: !production,
      validationRules: [depthLimitRule(config.graphql.maxDepth)],
      formatError: formatError(logger, production),
      // HTTP: Apollo pasa { req, res }. graphql-ws: pasa su Context (con connectionParams) y
      // se llama en cada operación, así el token se vuelve a verificar en cada subscribe.
      context: (arg: HttpContextArg | WsContextArg) =>
        'connectionParams' in arg || !('req' in arg)
          ? contexts.fromWs((arg as WsContextArg).connectionParams)
          : contexts.fromHttp(arg.req.headers),
      subscriptions: {
        'graphql-ws': {
          path: '/graphql',
          // Token inválido en connectionParams → se cierra la conexión (4403).
          onConnect: (ctx: WsContextArg) => contexts.checkConnection(ctx.connectionParams),
        },
      },
    });

    return {
      module: AppModule,
      imports: [graphql],
      controllers: [HealthController],
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: LOGGER, useValue: logger },
        { provide: METRICS, useValue: deps.metrics },
        { provide: BACKEND, useValue: deps.backend },
        { provide: VERIFIER, useValue: deps.verifier },
        { provide: PUBSUB, useValue: deps.pubsub },
        { provide: ASSISTANT, useValue: deps.assistant },
        { provide: CONSUMER, useValue: deps.consumer },
        { provide: 'CLOSE_BACKEND', useValue: deps.closeBackend ?? (async () => {}) },
        { provide: APP_FILTER, useClass: PassthroughGqlExceptionFilter },
        UsersResolver,
        ProblemsResolver,
        SubmissionsResolver,
        SubmissionFieldsResolver,
        ContestsResolver,
        ContestProblemFieldsResolver,
        AssistantResolver,
        SubscriptionsResolver,
      ],
    };
  }

  onApplicationBootstrap() {
    // Ninguno bloquea el arranque: si users o Kafka no responden, reintentan en segundo
    // plano con backoff y /ready responde 503 mientras tanto.
    void this.verifier.init();
    void this.consumer.start();
  }

  async onApplicationShutdown(signal?: string) {
    this.logger.info({ signal }, 'apagando el BFF');
    this.verifier.stop();
    await this.consumer.stop().catch(() => {});
    await this.closeBackend().catch(() => {});
  }
}
