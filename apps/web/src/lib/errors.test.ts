import { CombinedGraphQLErrors, ServerError, ServerParseError } from '@apollo/client/errors';
import { describe, expect, it } from 'vitest';
import { describeError, ERROR_MESSAGES, errorCode } from './errors';

const gqlError = (code: string, message = 'msg', extra: Record<string, unknown> = {}) =>
  new CombinedGraphQLErrors({ errors: [{ message, extensions: { code, ...extra } }] });

describe('describeError', () => {
  it('traduce UNAVAILABLE a un mensaje entendible', () => {
    expect(describeError(gqlError('UNAVAILABLE')).message).toBe(
      'El servicio no está disponible, intenta en un momento.',
    );
  });

  it.each([
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'NOT_FOUND',
    'CONFLICT',
    'INTERNAL_SERVER_ERROR',
    'ASSISTANT_DISABLED',
  ] as const)('traduce %s', (code) => {
    expect(describeError(gqlError(code))).toMatchObject({ code, message: ERROR_MESSAGES[code] });
  });

  it('conserva el detalle del servidor y aplica overrides', () => {
    const d = describeError(gqlError('BAD_USER_INPUT', 'title demasiado largo'), {
      BAD_USER_INPUT: 'Revisa el título',
    });
    expect(d).toMatchObject({
      code: 'BAD_USER_INPUT',
      message: 'Revisa el título',
      detail: 'title demasiado largo',
    });
  });

  it('normaliza los alias de rate limit y lee retryAfter', () => {
    expect(
      describeError(gqlError('TOO_MANY_REQUESTS', 'x', { retryAfterSeconds: 4.2 })),
    ).toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 5,
    });
    expect(errorCode(gqlError('RATE_LIMITED'))).toBe('RATE_LIMITED');
  });

  it('códigos desconocidos → UNKNOWN', () => {
    expect(errorCode(gqlError('WHATEVER'))).toBe('UNKNOWN');
    expect(errorCode(new CombinedGraphQLErrors({ errors: [{ message: 'x' }] }))).toBe('UNKNOWN');
    expect(errorCode('raro')).toBe('UNKNOWN');
  });

  it('errores HTTP del servidor', () => {
    const server = (status: number) =>
      new ServerError('fail', { response: new Response('', { status }), bodyText: '' });
    expect(errorCode(server(429))).toBe('RATE_LIMITED');
    expect(errorCode(server(401))).toBe('UNAUTHENTICATED');
    expect(errorCode(server(502))).toBe('UNAVAILABLE');
    expect(errorCode(server(418))).toBe('UNKNOWN');
    expect(
      errorCode(
        new ServerParseError(new Error('bad json'), {
          response: new Response('', { status: 200 }),
          bodyText: '<html>',
        }),
      ),
    ).toBe('UNAVAILABLE');
  });

  it('errores de red', () => {
    expect(describeError(new TypeError('Failed to fetch')).code).toBe('NETWORK');
    expect(describeError(new Error('socket closed')).code).toBe('NETWORK');
  });
});
