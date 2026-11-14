import { describe, expect, it } from 'vitest';
import { findUniqueViolation } from './errors.js';

describe('findUniqueViolation', () => {
  it('encuentra el constraint cuando el error es 23505', () => {
    const err = { code: '23505', constraint_name: 'submissions_id_key' };
    expect(findUniqueViolation(err)).toEqual({ constraint: 'submissions_id_key' });
  });

  it('busca en la cadena de cause', () => {
    const err = {
      message: 'Wrapped error',
      cause: {
        code: '23505',
        constraint_name: 'outbox_event_id_key',
      },
    };
    expect(findUniqueViolation(err)).toEqual({ constraint: 'outbox_event_id_key' });
  });

  it('devuelve undefined si no es 23505', () => {
    expect(findUniqueViolation({ code: '42P01' })).toBeUndefined();
    expect(findUniqueViolation(null)).toBeUndefined();
    expect(findUniqueViolation('error')).toBeUndefined();
  });
});
