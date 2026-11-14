/** Espacios en blanco ASCII: espacio, \t, \n, \v, \f, \r. */
function isSpace(byte: number): boolean {
  return byte === 0x20 || (byte >= 0x09 && byte <= 0x0d);
}

/**
 * Compara dos salidas por tokens separados por espacios en blanco (cualquier cantidad y
 * tipo). La comparación de cada token es exacta, byte a byte.
 */
export function tokensEqual(actual: Uint8Array, expected: Uint8Array): boolean {
  let i = 0;
  let j = 0;
  for (;;) {
    while (i < actual.length && isSpace(actual[i]!)) i++;
    while (j < expected.length && isSpace(expected[j]!)) j++;
    const actualDone = i >= actual.length;
    const expectedDone = j >= expected.length;
    if (actualDone || expectedDone) return actualDone && expectedDone;

    while (
      i < actual.length &&
      j < expected.length &&
      !isSpace(actual[i]!) &&
      !isSpace(expected[j]!)
    ) {
      if (actual[i] !== expected[j]) return false;
      i++;
      j++;
    }
    const actualTokenEnd = i >= actual.length || isSpace(actual[i]!);
    const expectedTokenEnd = j >= expected.length || isSpace(expected[j]!);
    if (actualTokenEnd !== expectedTokenEnd) return false;
  }
}
