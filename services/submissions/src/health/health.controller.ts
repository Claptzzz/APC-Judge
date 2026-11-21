import { Controller, Get, Header, HttpException, HttpStatus, Inject } from '@nestjs/common';
import type { Database } from '../db/client.js';
import type { JudgedConsumer } from '../kafka/judged.consumer.js';
import type { Metrics } from '../metrics.js';
import type { OutboxRelay } from '../outbox/relay.js';
import type { EventPublisher } from '../outbox/publisher.js';

@Controller()
export class HealthController {
  constructor(
    @Inject('Database')
    private readonly database: Database,
    @Inject('Metrics')
    private readonly metrics: Metrics,
    @Inject('EventPublisher')
    private readonly publisher: EventPublisher,
    @Inject('OutboxRelay')
    private readonly outboxRelay: OutboxRelay,
    @Inject('JudgedConsumer')
    private readonly judgedConsumer: Pick<JudgedConsumer, 'readiness'>,
  ) {}

  @Get('health')
  health() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    let dbStatus: 'ok' | 'down' = 'ok';
    let dbError: string | undefined;
    try {
      await this.database.ping(3000);
    } catch (err) {
      dbStatus = 'down';
      dbError = (err as Error).message;
    }

    const kafkaStatus = this.publisher.isConnected() ? 'ok' : 'down';
    const { consecutiveFailures, lastError } = this.outboxRelay.status;
    const outboxStatus = consecutiveFailures > 0 ? 'down' : 'ok';
    const consumer = this.judgedConsumer.readiness.status();
    const consumerStatus = consumer.ready ? 'ok' : 'down';

    const isReady = dbStatus === 'ok' && consumer.ready;

    const result = {
      status: isReady ? 'ready' : 'not_ready',
      checks: {
        database: { status: dbStatus, error: dbError },
        kafka: { status: kafkaStatus },
        outbox: { status: outboxStatus, error: lastError },
        judgedConsumer: {
          status: consumerStatus,
          joined: consumer.joined,
          crashed: consumer.crashed,
        },
      },
    };

    if (!isReady) {
      throw new HttpException(result, HttpStatus.SERVICE_UNAVAILABLE);
    }

    return result;
  }

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async getMetrics() {
    return this.metrics.registry.metrics();
  }
}
