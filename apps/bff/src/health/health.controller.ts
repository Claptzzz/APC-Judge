import { Controller, Get, Header, HttpException, HttpStatus, Inject } from '@nestjs/common';
import type { JwtVerifier } from '../auth/jwt-verifier.js';
import type { ConsumerHandle } from '../kafka/judged.consumer.js';
import type { Metrics } from '../metrics.js';
import { CONSUMER, METRICS, VERIFIER } from '../tokens.js';

/**
 * `/health`: el proceso está vivo. `/ready`: llave pública de users cargada y consumidor de
 * `submission.judged` unido a su grupo. Gemini y el MCP server no afectan `/ready` (si
 * fallan, solo `askAssistant` responde con error).
 */
@Controller()
export class HealthController {
  constructor(
    @Inject(VERIFIER) private readonly verifier: Pick<JwtVerifier, 'hasPublicKey'>,
    @Inject(CONSUMER) private readonly consumer: Pick<ConsumerHandle, 'readiness'>,
    @Inject(METRICS) private readonly metrics: Pick<Metrics, 'registry'>,
  ) {}

  @Get('health')
  health() {
    return { status: 'ok' };
  }

  @Get('ready')
  ready() {
    const keyLoaded = this.verifier.hasPublicKey();
    const consumer = this.consumer.readiness.status();
    const isReady = keyLoaded && consumer.ready;
    const body = {
      status: isReady ? 'ready' : 'not_ready',
      checks: {
        jwtPublicKey: { status: keyLoaded ? 'ok' : 'down' },
        judgedConsumer: {
          status: consumer.ready ? 'ok' : 'down',
          joined: consumer.joined,
          crashed: consumer.crashed,
        },
      },
    };
    if (!isReady) throw new HttpException(body, HttpStatus.SERVICE_UNAVAILABLE);
    return body;
  }

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  metricsText() {
    return this.metrics.registry.metrics();
  }
}
