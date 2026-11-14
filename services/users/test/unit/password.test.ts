import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCRYPT_PARAMS,
  getDummyHash,
  hashPassword,
  verifyPassword,
} from '../../src/auth/password.js';

const fast = { N: 1024, r: 8, p: 1, keyLength: 32, saltLength: 16 };

describe('password (scrypt)', () => {
  it('guarda parámetros y salt junto al hash', async () => {
    const hash = await hashPassword('clave-segura', fast);
    const [prefix, N, r, p, salt, key] = hash.split('$');
    expect([prefix, N, r, p]).toEqual(['scrypt', '1024', '8', '1']);
    expect(Buffer.from(salt!, 'base64')).toHaveLength(16);
    expect(Buffer.from(key!, 'base64')).toHaveLength(32);
  });

  it('usa salt aleatorio: dos hashes de la misma clave difieren', async () => {
    expect(await hashPassword('igual', fast)).not.toBe(await hashPassword('igual', fast));
  });

  it('verifica la clave correcta y rechaza otra', async () => {
    const hash = await hashPassword('clave-segura', fast);
    expect(await verifyPassword('clave-segura', hash)).toBe(true);
    expect(await verifyPassword('clave-segurA', hash)).toBe(false);
  });

  it('normaliza Unicode (NFKC) antes de derivar', async () => {
    const hash = await hashPassword('ﬁjo', fast); // ligadura "ﬁ"
    expect(await verifyPassword('fijo', hash)).toBe(true);
  });

  it('usa por defecto los parámetros recomendados (N=2^15, r=8, p=1)', async () => {
    expect(DEFAULT_SCRYPT_PARAMS).toMatchObject({ N: 32768, r: 8, p: 1 });
    const hash = await hashPassword('por-defecto');
    expect(hash.startsWith('scrypt$32768$8$1$')).toBe(true);
    expect(await verifyPassword('por-defecto', hash)).toBe(true);
  });

  it('devuelve false con hashes mal formados en vez de lanzar', async () => {
    for (const bad of ['', 'bcrypt$x', 'scrypt$a$8$1$c2FsdA==$a2V5', 'scrypt$1024$8$1$$a2V5']) {
      expect(await verifyPassword('x', bad)).toBe(false);
    }
  });

  it('el hash dummy es estable y verificable', async () => {
    const a = await getDummyHash();
    expect(await getDummyHash()).toBe(a);
    expect(await verifyPassword('otra', a)).toBe(false);
  });
});
