import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { memoryLogger, rsaPem } from '../helpers.js';

describe('startApp (fallos de arranque)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'users-app-'));
  writeFileSync(join(dir, 'priv.pem'), rsaPem().privatePem);

  it('falla si no puede leer la llave privada', async () => {
    const config = loadConfig({
      USERS_DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x',
      KAFKA_BROKERS: '127.0.0.1:1',
      JWT_PRIVATE_KEY_PATH: join(dir, 'no-existe.pem'),
    });
    await expect(startApp(config, memoryLogger().logger)).rejects.toThrow(/jwt:keys/);
  });

  it('si la BD no responde, libera lo abierto y propaga el error', async () => {
    const config = loadConfig({
      USERS_DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x',
      KAFKA_BROKERS: '127.0.0.1:1',
      JWT_PRIVATE_KEY_PATH: join(dir, 'priv.pem'),
    });
    const { logger, lines } = memoryLogger();
    await expect(startApp(config, logger)).rejects.toThrow();
    expect(lines().map((l) => l.msg)).toContain('apagado completo');
  });
});
