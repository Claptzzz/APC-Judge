import { createPrivateKey, createPublicKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export interface SigningKeys {
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** Llave pública en PEM SPKI (lo que devuelve GetPublicKey). */
  publicKeyPem: string;
}

export class KeyError extends Error {
  override name = 'KeyError';
}

/** Construye las llaves a partir de PEM. Si se entrega la pública, debe corresponder a la privada. */
export function keysFromPem(privatePem: string, publicPem?: string): SigningKeys {
  const privateKey = createPrivateKey(privatePem);
  if (privateKey.asymmetricKeyType !== 'rsa') {
    throw new KeyError(`La llave privada debe ser RSA (es ${privateKey.asymmetricKeyType})`);
  }
  const bits = privateKey.asymmetricKeyDetails?.modulusLength ?? 0;
  if (bits < 2048) throw new KeyError(`La llave RSA debe tener al menos 2048 bits (tiene ${bits})`);

  const derived = createPublicKey(privateKey);
  const derivedPem = derived.export({ type: 'spki', format: 'pem' }).toString();
  if (publicPem !== undefined) {
    const givenPem = createPublicKey(publicPem).export({ type: 'spki', format: 'pem' }).toString();
    if (givenPem !== derivedPem) {
      throw new KeyError('JWT_PUBLIC_KEY_PATH no corresponde a JWT_PRIVATE_KEY_PATH');
    }
  }
  return { privateKey, publicKey: derived, publicKeyPem: derivedPem };
}

export async function loadSigningKeys(
  privateKeyPath: string,
  publicKeyPath?: string,
): Promise<SigningKeys> {
  const read = async (path: string, name: string) => {
    try {
      return await readFile(path, 'utf8');
    } catch (err) {
      throw new KeyError(
        `No se pudo leer ${name} (${path}): ${(err as Error).message}. ¿Corriste \`pnpm jwt:keys\`?`,
      );
    }
  };
  const privatePem = await read(privateKeyPath, 'JWT_PRIVATE_KEY_PATH');
  const publicPem = publicKeyPath ? await read(publicKeyPath, 'JWT_PUBLIC_KEY_PATH') : undefined;
  return keysFromPem(privatePem, publicPem);
}
