import { collectDefaultMetrics, Counter, Histogram, Registry } from '@prometheus-io/client';
import { SERVICE_NAME } from './logger.js';

export interface Metrics {
  registry: Registry;
  rpcDuration: Histogram<'method' | 'code'>;
  eventsProcessed: Counter<'topic' | 'status'>;
  projectionWrites: Counter<'status'>;
}

export function createMetrics(opts: { defaultMetrics?: boolean } = {}): Metrics {
  const registry = new Registry();
  registry.setDefaultLabels({ service: SERVICE_NAME });
  if (opts.defaultMetrics ?? true) collectDefaultMetrics({ register: registry });
  return {
    registry,
    rpcDuration: new Histogram({
      name: 'rpc_server_duration_seconds',
      help: 'Duración de las RPC atendidas, por método y código',
      labelNames: ['method', 'code'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers: [registry],
    }),
    eventsProcessed: new Counter({
      name: 'kafka_events_processed_total',
      help: 'Eventos Kafka consumidos, por topic y resultado (processed, duplicate, dlq)',
      labelNames: ['topic', 'status'],
      registers: [registry],
    }),
    projectionWrites: new Counter({
      name: 'scoreboard_projection_writes_total',
      help: 'Escrituras de la proyección del scoreboard en Redis, por resultado (ok, error)',
      labelNames: ['status'],
      registers: [registry],
    }),
  };
}
