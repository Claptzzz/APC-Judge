import { describe, expect, it } from 'vitest';
import { createMetrics } from '../../src/metrics.js';
import { memoryLogger } from '../helpers.js';

describe('logger', () => {
  it('emite JSON con service=users, nivel como texto y redacta secretos', () => {
    const { logger, lines } = memoryLogger('info');
    logger.info(
      { password: 'secreto', user: { password: 'x' }, authorization: 'Bearer t' },
      'hola',
    );
    logger.debug('no aparece');
    const [line] = lines();
    expect(lines()).toHaveLength(1);
    expect(line).toMatchObject({
      service: 'users',
      level: 'info',
      msg: 'hola',
      password: '[redacted]',
      user: { password: '[redacted]' },
      authorization: '[redacted]',
    });
    expect(typeof line?.time).toBe('string');
  });
});

describe('metrics', () => {
  it('incluye métricas por defecto del proceso con la etiqueta service', async () => {
    const metrics = createMetrics();
    const text = await metrics.registry.metrics();
    expect(text).toContain('process_cpu_seconds_total{service="users"}');
  });
});
