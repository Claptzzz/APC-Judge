import { AUTH_METADATA_KEY } from '@juez/contracts';
import { Code, ConnectError } from '@connectrpc/connect';
import { InvalidTokenError } from '../auth/tokens.js';
import type { TokenClaims, TokenService } from '../auth/tokens.js';

/**
 * Lee `authorization: Bearer <jwt>` de la metadata y verifica el token.
 * Lanza `unauthenticated` si falta o es inválido.
 */
export async function authenticate(headers: Headers, tokens: TokenService): Promise<TokenClaims> {
  const value = headers.get(AUTH_METADATA_KEY);
  if (!value) throw new ConnectError('Falta el token de acceso', Code.Unauthenticated);
  const match = /^Bearer\s+(\S+)$/i.exec(value.trim());
  if (!match?.[1]) {
    throw new ConnectError(
      'Formato de authorization inválido (Bearer <jwt>)',
      Code.Unauthenticated,
    );
  }
  try {
    return await tokens.verify(match[1]);
  } catch (err) {
    if (err instanceof InvalidTokenError) throw new ConnectError(err.message, Code.Unauthenticated);
    throw err;
  }
}
