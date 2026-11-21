import { describe, expect, it } from 'vitest';
import { startApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { silentLogger } from '../helpers.js';

// Arranque con todas las dependencias caídas (puertos cerrados): el servicio debe arrancar,
// /health responde 200 y /ready 503, y el apagado es ordenado.
describe('startApp sin dependencias disponibles', () => {
  it('arranca igual, /ready responde 503 y se apaga limpio', async () => {
    const config = loadConfig({
      RANKING_HTTP_PORT: '0',
      RANKING_GRPC_PORT: '0',
      RANKING_DATABASE_URL: 'postgres://u:p@127.0.0.1:1/ranking',
      RANKING_REDIS_URL: 'redis://127.0.0.1:1/0',
      KAFKA_BROKERS: '127.0.0.1:1',
      USERS_GRPC_ADDR: '127.0.0.1:1',
      PROBLEMS_GRPC_ADDR: '127.0.0.1:1',
      LOG_LEVEL: 'silent',
    });
    const app = await startApp(config, silentLogger);
    try {
      const base = `http://127.0.0.1:${app.ports.http}`;
      expect((await fetch(`${base}/health`)).status).toBe(200);
      const ready = await fetch(`${base}/ready`);
      expect(ready.status).toBe(503);
      const body = (await ready.json()) as { checks: Record<string, { status: string }> };
      expect(body.checks.database?.status).toBe('down');
      expect(body.checks.kafkaConsumer?.status).toBe('down');
      expect(body.checks.redis?.status).toBe('degraded');
      expect(app.ports.grpc).toBeGreaterThan(0);
    } finally {
      await app.stop();
    }
  }, 20_000);
});
