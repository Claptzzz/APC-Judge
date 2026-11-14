import { describe, expect, it } from 'vitest';
import { detectSandbox, findExecutable, probe } from './capabilities.js';

describe('findExecutable', () => {
  it('busca en PATH y acepta rutas absolutas', async () => {
    expect(await findExecutable('sh')).toMatch(/\/sh$/);
    expect(await findExecutable('/bin/sh')).toBe('/bin/sh');
    expect(await findExecutable('/no/existe')).toBeNull();
    expect(await findExecutable('no-existe-este-binario', '/usr/bin')).toBeNull();
  });
});

describe('probe', () => {
  it('indica si el comando terminó con código 0', async () => {
    expect(await probe('true', [])).toBe(true);
    expect(await probe('false', [])).toBe(false);
    expect(await probe('/no/existe', [])).toBe(false);
  });
});

describe('detectSandbox', () => {
  it('encuentra prlimit y detecta unshare/time opcionales', async () => {
    const sandbox = await detectSandbox();
    expect(sandbox.prlimit).toMatch(/prlimit$/);
    expect(sandbox.unshare === null || sandbox.unshare.endsWith('unshare')).toBe(true);
    expect(sandbox.time === null || sandbox.time.endsWith('time')).toBe(true);
  });

  it('falla si no hay prlimit', async () => {
    await expect(detectSandbox({ path: '/no/existe' })).rejects.toThrow(/prlimit/);
  });

  it('deja time en null si la ruta no existe', async () => {
    const sandbox = await detectSandbox({ timePath: '/no/existe/time' });
    expect(sandbox.time).toBeNull();
  });
});
