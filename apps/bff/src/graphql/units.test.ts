import { common, problems, ranking } from '@juez/contracts/nest';
import { Kind } from 'graphql';
import { describe, expect, it } from 'vitest';
import { toJudgedEvent } from '../events/judged.js';
import { ALICE, BOB, sampleSubmission, sampleUser } from '../test-utils/fixtures.js';
import {
  contestLetter,
  contestStatusToProto,
  difficultyFromProto,
  difficultyToProto,
  isoFromTimestamp,
  languageToProto,
  mapLogin,
  mapSubmission,
  mapUser,
  roleFromProto,
  timestampFromDate,
  verdictFromProto,
} from './mappers.js';
import { DateTimeScalar } from './scalars.js';

describe('mappers', () => {
  it('enums sin prefijo ni UNSPECIFIED, y de vuelta al proto', () => {
    expect(verdictFromProto(common.Verdict.VERDICT_TIME_LIMIT_EXCEEDED)).toBe(
      'TIME_LIMIT_EXCEEDED',
    );
    expect(verdictFromProto(common.Verdict.VERDICT_UNSPECIFIED)).toBe('PENDING');
    expect(verdictFromProto(99)).toBe('PENDING');
    expect(roleFromProto(common.Role.ROLE_ADMIN)).toBe('ADMIN');
    expect(difficultyFromProto(problems.Difficulty.DIFFICULTY_HARD)).toBe('HARD');
    expect(languageToProto('PYTHON3')).toBe(common.Language.LANGUAGE_PYTHON3);
    expect(difficultyToProto(null)).toBe(problems.Difficulty.DIFFICULTY_UNSPECIFIED);
    expect(contestStatusToProto('UPCOMING')).toBe(ranking.ContestStatus.CONTEST_STATUS_UPCOMING);
    expect(contestStatusToProto(undefined)).toBe(0);
  });

  it('timestamps ↔ ISO UTC con milisegundos', () => {
    expect(isoFromTimestamp({ seconds: '1763820000', nanos: 123_456_789 })).toBe(
      '2025-11-22T14:00:00.123Z',
    );
    expect(isoFromTimestamp({ seconds: 1_763_820_000n, nanos: 0 })).toBe(
      '2025-11-22T14:00:00.000Z',
    );
    expect(isoFromTimestamp({ seconds: 0, nanos: 0 })).toBeNull();
    expect(isoFromTimestamp(null)).toBeNull();
    expect(timestampFromDate(new Date('2025-11-22T14:00:00.250Z'))).toEqual({
      seconds: 1_763_820_000,
      nanos: 250_000_000,
    });
    expect(contestLetter(0)).toBe('A');
    expect(contestLetter(25)).toBe('Z');
  });

  it('email solo para el propio usuario o ADMIN', () => {
    expect(mapUser(sampleUser(ALICE), { sub: ALICE.sub, role: 'CONTESTANT' }).email).toBe(
      'alice@juez.test',
    );
    expect(mapUser(sampleUser(ALICE), { sub: BOB.sub, role: 'CONTESTANT' }).email).toBeNull();
    expect(mapUser(sampleUser(ALICE), { sub: BOB.sub, role: 'ADMIN' }).email).toBe(
      'alice@juez.test',
    );
    expect(mapUser(sampleUser(ALICE), undefined).email).toBeNull();
  });

  it('login sin usuario es un error interno', () => {
    expect(() =>
      mapLogin({ accessToken: 't', tokenType: 'Bearer', expiresAt: undefined, user: undefined }),
    ).toThrow();
  });

  it('submission sin veredicto final: métricas en null; final: valores tal cual', () => {
    const pending = mapSubmission(sampleSubmission({ timeMs: 5 }), undefined);
    expect(pending).toMatchObject({ timeMs: null, judgedAt: null, contestId: null });
    const ce = mapSubmission(
      sampleSubmission({
        verdict: common.Verdict.VERDICT_COMPILATION_ERROR,
        judgedAt: { seconds: 1_763_820_000, nanos: 0 },
      }),
      undefined,
    );
    expect(ce).toMatchObject({ verdict: 'COMPILATION_ERROR', timeMs: 0, totalCases: 0 });
    expect(ce.judgedAt).toBe('2025-11-22T14:00:00.000Z');
  });

  it('evento de Kafka sin occurred_at usa la hora de recepción', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const ev = toJudgedEvent(
      {
        eventId: 'e',
        submissionId: 's',
        userId: 'u',
        problemId: 'p',
        verdict: common.Verdict.VERDICT_ACCEPTED,
        timeMs: 1,
        memoryKb: 2,
        passedCases: 3,
        totalCases: 3,
      } as never,
      now,
    );
    expect(ev).toMatchObject({ verdict: 'ACCEPTED', contestId: null, judgedAt: now.toISOString() });
  });
});

describe('DateTime', () => {
  it('acepta RFC 3339 con offset y serializa en UTC con ms', () => {
    expect(DateTimeScalar.parseValue('2026-11-22T12:04:05-03:00')).toEqual(
      new Date('2026-11-22T15:04:05.000Z'),
    );
    expect(DateTimeScalar.serialize(new Date('2026-11-22T15:04:05Z'))).toBe(
      '2026-11-22T15:04:05.000Z',
    );
    expect(DateTimeScalar.serialize('2026-11-22T15:04:05.1Z')).toBe('2026-11-22T15:04:05.100Z');
    expect(
      DateTimeScalar.parseLiteral({ kind: Kind.STRING, value: '2026-11-22T15:04:05Z' }, {}),
    ).toEqual(new Date('2026-11-22T15:04:05Z'));
  });

  it('rechaza fechas sin zona, inválidas o de otro tipo', () => {
    expect(() => DateTimeScalar.parseValue('2026-11-22T15:04:05')).toThrow();
    expect(() => DateTimeScalar.parseValue('2026-13-45T99:00:00Z')).toThrow();
    expect(() => DateTimeScalar.parseValue(123)).toThrow();
    expect(() => DateTimeScalar.parseLiteral({ kind: Kind.INT, value: '1' }, {})).toThrow();
    expect(() => DateTimeScalar.serialize('no-fecha')).toThrow();
  });
});
