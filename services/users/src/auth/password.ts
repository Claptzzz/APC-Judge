import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import type { ScryptOptions } from 'node:crypto';

/**
 * Hash de contraseñas con scrypt de node:crypto. Formato autodescriptivo, para poder
 * subir los parámetros sin invalidar los hashes existentes:
 *   scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>
 */
export interface ScryptParams {
  N: number;
  r: number;
  p: number;
  keyLength: number;
  saltLength: number;
}

// N = 2^15, r = 8, p = 1: parámetros recomendados por OWASP para scrypt (~32 MiB por hash).
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = {
  N: 2 ** 15,
  r: 8,
  p: 1,
  keyLength: 64,
  saltLength: 16,
};

const PREFIX = 'scrypt';

function scrypt(password: string, salt: Buffer, keyLength: number, options: ScryptOptions) {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCb(password.normalize('NFKC'), salt, keyLength, options, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

function options({ N, r, p }: Pick<ScryptParams, 'N' | 'r' | 'p'>): ScryptOptions {
  // maxmem por defecto (32 MiB) es justo el mínimo de N=2^15,r=8; se deja holgura.
  return { N, r, p, maxmem: 256 * N * r };
}

export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<string> {
  const salt = randomBytes(params.saltLength);
  const key = await scrypt(password, salt, params.keyLength, options(params));
  return [
    PREFIX,
    params.N,
    params.r,
    params.p,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

function parseHash(stored: string): ParsedHash | undefined {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) return undefined;
  const [N, r, p] = parts.slice(1, 4).map((v) => Number(v));
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const key = Buffer.from(parts[5] ?? '', 'base64');
  if (![N, r, p].every((v) => Number.isSafeInteger(v) && v! > 0)) return undefined;
  if (salt.length === 0 || key.length === 0) return undefined;
  return { N: N!, r: r!, p: p!, salt, key };
}

/**
 * Verifica una contraseña contra un hash almacenado. La comparación final usa
 * `timingSafeEqual`. Un hash mal formado devuelve false (no lanza).
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  const candidate = await scrypt(password, parsed.salt, parsed.key.length, options(parsed));
  return timingSafeEqual(candidate, parsed.key);
}

let dummyHash: Promise<string> | undefined;

/**
 * Hash fijo para verificar cuando el usuario no existe, de modo que un login con usuario
 * inexistente tarde lo mismo que uno con contraseña incorrecta (evita enumerar usuarios).
 */
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword('juez-dummy-password');
  return dummyHash;
}
