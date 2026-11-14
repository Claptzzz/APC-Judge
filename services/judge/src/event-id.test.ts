import { describe, expect, it } from 'vitest';
import { JUDGED_EVENT_NAMESPACE, judgedEventId, uuidV5 } from './event-id.js';

describe('uuidV5', () => {
  it('coincide con el vector conocido de RFC (namespace DNS)', () => {
    expect(uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    );
  });

  it('rechaza un namespace inválido', () => {
    expect(() => uuidV5('x', 'no-es-uuid')).toThrow(/UUID inválido/);
  });
});

describe('judgedEventId', () => {
  it('es determinista por submission y distinto entre submissions', () => {
    const a = judgedEventId('22222222-2222-4222-8222-222222222222');
    expect(judgedEventId('22222222-2222-4222-8222-222222222222')).toBe(a);
    expect(judgedEventId('33333333-3333-4333-8333-333333333333')).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).toBe(uuidV5('22222222-2222-4222-8222-222222222222', JUDGED_EVENT_NAMESPACE));
  });
});
