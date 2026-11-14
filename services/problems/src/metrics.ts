import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';
import { SERVICE_NAME } from './logger.js';

export interface Metrics {
  registry: Registry;
  rpcHandled: Counter<'method' | 'code'>;
  rpcDuration: Histogram<'method'>;
}

export function createMetrics({ defaultMetrics = true } = {}): Metrics {
  const registry = new Registry();
  registry.setDefaultLabels({ service: SERVICE_NAME });
  if (defaultMetrics) collectDefaultMetrics({ register: registry });
  return {
    registry,
    rpcHandled: new Counter({
      name: 'grpc_server_handled_total',
      help: 'RPCs atendidas, por método y código de estado',
      labelNames: ['method', 'code'],
      registers: [registry],
    }),
    rpcDuration: new Histogram({
      name: 'grpc_server_handling_seconds',
      help: 'Duración de las RPCs en segundos',
      labelNames: ['method'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [registry],
    }),
  };
}
