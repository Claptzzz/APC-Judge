import { createContextKey } from '@connectrpc/connect';
import type { Logger } from '../logger.js';

export const REQUEST_ID_HEADER = 'x-request-id';

export const kRequestId = createContextKey<string>('', { description: 'x-request-id' });
export const kLogger = createContextKey<Logger | undefined>(undefined, {
  description: 'logger de la petición',
});
