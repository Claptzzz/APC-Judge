import { timestampFromDate, timestampDate } from '@bufbuild/protobuf/wkt';
import { describe, expect, it } from 'vitest';
import { Language, Verdict } from './gen/es/juez/common/v1/common_pb.js';
import { decodeEvent, encodeEvent, EVENT_CONTENT_TYPE } from './events.js';
import { DlqTopics, Topics } from './topics.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const occurredAt = timestampFromDate(new Date('2026-11-10T12:00:00.123Z'));

describe('round-trip encode/decode', () => {
  it('UserRegistered', () => {
    const encoded = encodeEvent(Topics.USER_REGISTERED, {
      eventId: '0b9f2f7e-2b8a-4c1e-9d3a-4f6a7b8c9d0e',
      occurredAt,
      userId: '11111111-1111-4111-8111-111111111111',
      username: 'ada',
    });

    expect(encoded.key).toBe('11111111-1111-4111-8111-111111111111');
    expect(encoded.headers).toEqual({
      'content-type': EVENT_CONTENT_TYPE,
      'event-type': 'juez.events.v1.UserRegistered',
      'event-id': '0b9f2f7e-2b8a-4c1e-9d3a-4f6a7b8c9d0e',
    });

    const decoded = decodeEvent(Topics.USER_REGISTERED, encoded.value);
    expect(decoded.eventId).toBe('0b9f2f7e-2b8a-4c1e-9d3a-4f6a7b8c9d0e');
    expect(decoded.userId).toBe('11111111-1111-4111-8111-111111111111');
    expect(decoded.username).toBe('ada');
    expect(timestampDate(decoded.occurredAt!).toISOString()).toBe('2026-11-10T12:00:00.123Z');
  });

  it('SubmissionCreated con contest_id', () => {
    const encoded = encodeEvent(Topics.SUBMISSION_CREATED, {
      submissionId: '22222222-2222-4222-8222-222222222222',
      userId: '11111111-1111-4111-8111-111111111111',
      problemId: '33333333-3333-4333-8333-333333333333',
      contestId: '44444444-4444-4444-8444-444444444444',
      language: Language.CPP17,
      sourceCode: '#include <cstdio>\nint main(){puts("hola");}',
    });

    expect(encoded.key).toBe('22222222-2222-4222-8222-222222222222');
    const decoded = decodeEvent(Topics.SUBMISSION_CREATED, encoded.value);
    expect(decoded).toMatchObject({
      eventId: encoded.event.eventId,
      submissionId: '22222222-2222-4222-8222-222222222222',
      userId: '11111111-1111-4111-8111-111111111111',
      problemId: '33333333-3333-4333-8333-333333333333',
      contestId: '44444444-4444-4444-8444-444444444444',
      language: Language.CPP17,
      sourceCode: '#include <cstdio>\nint main(){puts("hola");}',
    });
  });

  it('SubmissionCreated sin contest_id distingue ausencia de string vacío', () => {
    const encoded = encodeEvent(Topics.SUBMISSION_CREATED, {
      submissionId: '22222222-2222-4222-8222-222222222222',
      userId: '11111111-1111-4111-8111-111111111111',
      problemId: '33333333-3333-4333-8333-333333333333',
      language: Language.PYTHON3,
      sourceCode: 'print(input())',
    });
    const decoded = decodeEvent(Topics.SUBMISSION_CREATED, encoded.value);
    expect(decoded.contestId).toBeUndefined();
    expect(decoded.language).toBe(Language.PYTHON3);
  });

  it('SubmissionJudged', () => {
    const submittedAt = timestampFromDate(new Date('2026-11-10T11:59:58Z'));
    const encoded = encodeEvent(Topics.SUBMISSION_JUDGED, {
      occurredAt,
      submissionId: '22222222-2222-4222-8222-222222222222',
      userId: '11111111-1111-4111-8111-111111111111',
      problemId: '33333333-3333-4333-8333-333333333333',
      contestId: '44444444-4444-4444-8444-444444444444',
      verdict: Verdict.TIME_LIMIT_EXCEEDED,
      timeMs: 2001,
      memoryKb: 65536,
      passedCases: 7,
      totalCases: 12,
      submittedAt,
    });

    expect(encoded.key).toBe('22222222-2222-4222-8222-222222222222');
    expect(encoded.headers['event-type']).toBe('juez.events.v1.SubmissionJudged');
    const decoded = decodeEvent(Topics.SUBMISSION_JUDGED, encoded.value);
    expect(decoded).toMatchObject({
      submissionId: '22222222-2222-4222-8222-222222222222',
      contestId: '44444444-4444-4444-8444-444444444444',
      verdict: Verdict.TIME_LIMIT_EXCEEDED,
      timeMs: 2001,
      memoryKb: 65536,
      passedCases: 7,
      totalCases: 12,
    });
    expect(timestampDate(decoded.submittedAt!).toISOString()).toBe('2026-11-10T11:59:58.000Z');
  });
});

describe('encodeEvent', () => {
  it('asigna event_id (UUID v4) y occurred_at si faltan', () => {
    const before = Date.now();
    const { event, headers } = encodeEvent(Topics.USER_REGISTERED, {
      userId: '11111111-1111-4111-8111-111111111111',
      username: 'grace',
    });
    expect(event.eventId).toMatch(UUID_RE);
    expect(headers['event-id']).toBe(event.eventId);
    expect(timestampDate(event.occurredAt!).getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it('genera event_id distintos en cada llamada', () => {
    const init = { userId: '11111111-1111-4111-8111-111111111111', username: 'x' };
    const a = encodeEvent(Topics.USER_REGISTERED, init);
    const b = encodeEvent(Topics.USER_REGISTERED, init);
    expect(a.event.eventId).not.toBe(b.event.eventId);
  });

  it('devuelve un Buffer utilizable por kafkajs', () => {
    const { value } = encodeEvent(Topics.USER_REGISTERED, { userId: 'u', username: 'x' });
    expect(Buffer.isBuffer(value)).toBe(true);
    expect(value.byteLength).toBeGreaterThan(0);
  });

  it('falla si falta el id del agregado (key)', () => {
    expect(() => encodeEvent(Topics.SUBMISSION_JUDGED, { verdict: Verdict.ACCEPTED })).toThrow(
      /submissionId/,
    );
  });
});

describe('decodeEvent', () => {
  it('acepta el topic DLQ y usa el schema del topic base', () => {
    const { value } = encodeEvent(Topics.SUBMISSION_JUDGED, {
      submissionId: 's',
      verdict: Verdict.WRONG_ANSWER,
    });
    const decoded = decodeEvent(DlqTopics.SUBMISSION_JUDGED, value);
    expect(decoded.verdict).toBe(Verdict.WRONG_ANSWER);
  });

  it('falla con valor vacío o nulo', () => {
    expect(() => decodeEvent(Topics.USER_REGISTERED, null)).toThrow(/vacío/);
    expect(() => decodeEvent(Topics.USER_REGISTERED, new Uint8Array())).toThrow(/vacío/);
  });

  it('falla con bytes que no son protobuf válido', () => {
    expect(() => decodeEvent(Topics.USER_REGISTERED, new Uint8Array([0xff, 0xff, 0xff]))).toThrow();
  });

  it('falla con un topic desconocido', () => {
    expect(() => decodeEvent('otro.topic' as never, new Uint8Array([0x0a, 0x00]))).toThrow(
      /desconocido/,
    );
  });
});
