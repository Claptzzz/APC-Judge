import { collectDefaultMetrics, Counter, Registry } from '@prometheus-io/client';
import { SERVICE_NAME } from './logger.js';

export interface Metrics {
  registry: Registry;
  eventsProcessed: Counter<'topic' | 'status'>;
  assistantRequests: Counter<'outcome'>;
}

export function createMetrics(opts: { defaultMetrics?: boolean } = {}): Metrics {
  const registry = new Registry();
  registry.setDefaultLabels({ service: SERVICE_NAME });
  if (opts.defaultMetrics ?? true) collectDefaultMetrics({ register: registry });
  return {
    registry,
    eventsProcessed: new Counter({
      name: 'events_processed_total',
      help: 'Eventos Kafka procesados',
      labelNames: ['topic', 'status'],
      registers: [registry],
    }),
    assistantRequests: new Counter({
      name: 'assistant_requests_total',
      help: 'Preguntas al asistente, por resultado',
      labelNames: ['outcome'],
      registers: [registry],
    }),
  };
}
