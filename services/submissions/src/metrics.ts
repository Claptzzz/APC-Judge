import { collectDefaultMetrics, Counter, Histogram, Registry } from '@prometheus-io/client';
import { SERVICE_NAME } from './logger.js';

export interface Metrics {
  registry: Registry;
  rpcDuration: Histogram<'method' | 'code'>;
  outboxPublished: Counter;
  eventsProcessed: Counter<'topic' | 'status'>;
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
    outboxPublished: new Counter({
      name: 'outbox_published_total',
      help: 'Mensajes del outbox publicados en Kafka',
      registers: [registry],
    }),
    eventsProcessed: new Counter({
      name: 'events_processed_total',
      help: 'Eventos Kafka procesados',
      labelNames: ['topic', 'status'],
      registers: [registry],
    }),
  };
}
