import { describe, expect, it } from 'vitest';
import { tokensEqual } from './compare.js';

const eq = (a: string, b: string) => tokensEqual(Buffer.from(a), Buffer.from(b));

describe('tokensEqual', () => {
  it('ignora cantidad y tipo de espacios en blanco', () => {
    expect(eq('1 2 3\n', '1 2 3')).toBe(true);
    expect(eq('  1\t2\r\n3  \n\n', '1 2 3')).toBe(true);
    expect(eq('', '')).toBe(true);
    expect(eq('\n \n', '')).toBe(true);
  });

  it('detecta tokens distintos, faltantes o sobrantes', () => {
    expect(eq('1 2 4', '1 2 3')).toBe(false);
    expect(eq('1 2', '1 2 3')).toBe(false);
    expect(eq('1 2 3 4', '1 2 3')).toBe(false);
    expect(eq('12 3', '1 23')).toBe(false);
    expect(eq('123', '12')).toBe(false);
    expect(eq('12', '123')).toBe(false);
    expect(eq('', '1')).toBe(false);
  });

  it('compara cada token de forma exacta (mayúsculas, decimales)', () => {
    expect(eq('YES', 'yes')).toBe(false);
    expect(eq('1.0', '1')).toBe(false);
  });
});
