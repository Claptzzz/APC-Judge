import { describe, expect, it } from 'vitest';
import {
  computeContestRows,
  computeFirstSolvers,
  computeProblemCell,
  computeUserRow,
  countsAsAttempt,
  inContestWindow,
  rankRows,
  scoreOf,
} from '../../src/domain/icpc.js';
import type { UserRow } from '../../src/domain/types.js';
import { makeContest, minutes, sub, T0, uuid } from '../helpers.js';

const contest = makeContest();
const [A, B, C] = contest.problemIds as [string, string, string];
const at = (m: number, s = 0) => new Date(minutes(m).getTime() + s * 1000);

describe('reglas ICPC por problema', () => {
  it('penalización = minuto del primer AC + 20 × rechazos previos', () => {
    const cell = computeProblemCell(contest, A, [
      sub({ problemId: A, verdict: 'WRONG_ANSWER', submittedAt: at(10) }),
      sub({ problemId: A, verdict: 'TIME_LIMIT_EXCEEDED', submittedAt: at(20) }),
      sub({ problemId: A, verdict: 'ACCEPTED', submittedAt: at(45, 59) }),
    ]);
    expect(cell).toEqual({
      problemId: A,
      solved: true,
      attempts: 3,
      solvedAtMinute: 45, // minutos enteros (45:59 -> 45)
      penaltyMinutes: 45 + 2 * 20,
    });
  });

  it('con eventos desordenados, el primer AC es el de menor submitted_at', () => {
    // Orden de llegada: AC tardío, WA, AC temprano, WA posterior.
    const arrival = [
      sub({ problemId: A, verdict: 'ACCEPTED', submittedAt: at(90) }),
      sub({ problemId: A, verdict: 'WRONG_ANSWER', submittedAt: at(30) }),
      sub({ problemId: A, verdict: 'ACCEPTED', submittedAt: at(60) }),
      sub({ problemId: A, verdict: 'WRONG_ANSWER', submittedAt: at(70) }),
    ];
    const expected = { solved: true, attempts: 2, solvedAtMinute: 60, penaltyMinutes: 80 };
    expect(computeProblemCell(contest, A, arrival)).toMatchObject(expected);
    expect(computeProblemCell(contest, A, [...arrival].reverse())).toMatchObject(expected);
  });

  it('los rechazos posteriores al primer AC no penalizan', () => {
    const cell = computeProblemCell(contest, A, [
      sub({ problemId: A, verdict: 'ACCEPTED', submittedAt: at(5) }),
      sub({ problemId: A, verdict: 'WRONG_ANSWER', submittedAt: at(6) }),
    ]);
    expect(cell).toMatchObject({ attempts: 1, penaltyMinutes: 5 });
  });

  it('un rechazo con el mismo submitted_at que el AC no cuenta como anterior', () => {
    const cell = computeProblemCell(contest, A, [
      sub({ problemId: A, verdict: 'WRONG_ANSWER', submittedAt: at(7) }),
      sub({ problemId: A, verdict: 'ACCEPTED', submittedAt: at(7) }),
    ]);
    expect(cell).toMatchObject({ solved: true, attempts: 1, penaltyMinutes: 7 });
  });

  it('COMPILATION_ERROR e INTERNAL_ERROR no penalizan ni cuentan como intento', () => {
    expect(countsAsAttempt('COMPILATION_ERROR')).toBe(false);
    expect(countsAsAttempt('INTERNAL_ERROR')).toBe(false);
    expect(countsAsAttempt('RUNTIME_ERROR')).toBe(true);
    const cell = computeProblemCell(contest, A, [
      sub({ problemId: A, verdict: 'COMPILATION_ERROR', submittedAt: at(1) }),
      sub({ problemId: A, verdict: 'INTERNAL_ERROR', submittedAt: at(2) }),
      sub({ problemId: A, verdict: 'RUNTIME_ERROR', submittedAt: at(3) }),
      sub({ problemId: A, verdict: 'COMPILATION_ERROR', submittedAt: at(4) }),
      sub({ problemId: A, verdict: 'ACCEPTED', submittedAt: at(10) }),
    ]);
    expect(cell).toMatchObject({ solved: true, attempts: 2, penaltyMinutes: 10 + 20 });
  });

  it('sin AC: intentos = envíos que cuentan, sin penalización', () => {
    const cell = computeProblemCell(contest, B, [
      sub({ problemId: B, verdict: 'WRONG_ANSWER', submittedAt: at(1) }),
      sub({ problemId: B, verdict: 'COMPILATION_ERROR', submittedAt: at(2) }),
      sub({ problemId: B, verdict: 'MEMORY_LIMIT_EXCEEDED', submittedAt: at(3) }),
    ]);
    expect(cell).toEqual({
      problemId: B,
      solved: false,
      attempts: 2,
      solvedAtMinute: 0,
      penaltyMinutes: 0,
    });
  });
});

describe('ventana del contest [start, end)', () => {
  it('incluye el inicio y excluye el fin', () => {
    expect(inContestWindow(contest, T0)).toBe(true);
    expect(inContestWindow(contest, new Date(T0.getTime() - 1))).toBe(false);
    expect(inContestWindow(contest, new Date(contest.endTime.getTime() - 1))).toBe(true);
    expect(inContestWindow(contest, contest.endTime)).toBe(false);
  });

  it('ignora submissions fuera de la ventana (ni penalizan ni resuelven)', () => {
    const row = computeUserRow(contest, uuid(1), 'alice', [
      sub({ problemId: A, verdict: 'WRONG_ANSWER', submittedAt: at(-1) }),
      sub({ problemId: A, verdict: 'ACCEPTED', submittedAt: at(-0.5) }),
      sub({ problemId: A, verdict: 'ACCEPTED', submittedAt: at(20) }),
      sub({ problemId: B, verdict: 'ACCEPTED', submittedAt: contest.endTime }),
    ]);
    expect(row).toMatchObject({ solved: 1, penaltyMinutes: 20 });
    expect(row?.problems[1]).toMatchObject({ problemId: B, solved: false, attempts: 0 });
  });

  it('un usuario con envíos solo fuera de la ventana no aparece', () => {
    const subs = [sub({ problemId: A, verdict: 'ACCEPTED', submittedAt: at(400) })];
    expect(computeUserRow(contest, uuid(1), 'alice', subs)).toBeUndefined();
    expect(computeContestRows(contest, subs, new Map())).toEqual([]);
  });

  it('ignora problemas que no son del contest y submissions de otro contest', () => {
    const row = computeUserRow(contest, uuid(1), '', [
      sub({ problemId: uuid(9, 'a'), verdict: 'ACCEPTED', submittedAt: at(1) }),
      sub({ problemId: A, verdict: 'ACCEPTED', submittedAt: at(1), contestId: uuid(2, 'c') }),
      sub({ problemId: A, verdict: 'ACCEPTED', submittedAt: at(1), contestId: null }),
    ]);
    expect(row).toBeUndefined();
  });
});

describe('fila, orden y rank', () => {
  it('suma resueltos y penalización, con las celdas en el orden del contest', () => {
    const row = computeUserRow(contest, uuid(1), 'alice', [
      sub({ problemId: C, verdict: 'ACCEPTED', submittedAt: at(30) }),
      sub({ problemId: A, verdict: 'WRONG_ANSWER', submittedAt: at(5) }),
      sub({ problemId: A, verdict: 'ACCEPTED', submittedAt: at(12) }),
    ]);
    expect(row).toMatchObject({ userId: uuid(1), username: 'alice', solved: 2 });
    expect(row?.penaltyMinutes).toBe(12 + 20 + 30);
    expect(row?.problems.map((p) => p.problemId)).toEqual([A, B, C]);
  });

  it('score = resueltos × 10^7 − penalización', () => {
    expect(scoreOf({ solved: 3, penaltyMinutes: 125 })).toBe(29_999_875);
    expect(scoreOf({ solved: 0, penaltyMinutes: 0 })).toBe(0);
  });

  const row = (userId: string, solved: number, penaltyMinutes: number): UserRow => ({
    userId,
    username: '',
    solved,
    penaltyMinutes,
    problems: [],
  });

  it('ordena por más resueltos y luego menor penalización; empates comparten rank', () => {
    const ranked = rankRows([
      row(uuid(1), 1, 10),
      row(uuid(2), 2, 300),
      row(uuid(3), 2, 100),
      row(uuid(4), 2, 100),
      row(uuid(5), 0, 0),
    ]);
    expect(ranked.map((r) => [r.userId, r.rank])).toEqual([
      [uuid(4), 1], // empate: mismo orden que ZREVRANGE (user_id desc)
      [uuid(3), 1],
      [uuid(2), 3],
      [uuid(1), 4],
      [uuid(5), 5],
    ]);
  });

  it('computeContestRows agrupa por usuario y usa los usernames conocidos', () => {
    const rows = computeContestRows(
      contest,
      [
        sub({ userId: uuid(1), problemId: A, verdict: 'ACCEPTED', submittedAt: at(3) }),
        sub({ userId: uuid(2), problemId: A, verdict: 'WRONG_ANSWER', submittedAt: at(3) }),
      ],
      new Map([[uuid(1), 'alice']]),
    );
    expect(rows.map((r) => [r.userId, r.username, r.solved])).toEqual([
      [uuid(1), 'alice', 1],
      [uuid(2), '', 0],
    ]);
  });

  it('primer en resolver: menor submitted_at por problema, aunque llegue después', () => {
    const late = sub({ userId: uuid(1), problemId: A, verdict: 'ACCEPTED', submittedAt: at(50) });
    const early = sub({ userId: uuid(2), problemId: A, verdict: 'ACCEPTED', submittedAt: at(20) });
    const outside = sub({
      userId: uuid(3),
      problemId: B,
      verdict: 'ACCEPTED',
      submittedAt: at(-5),
    });
    const wa = sub({ userId: uuid(3), problemId: C, verdict: 'WRONG_ANSWER', submittedAt: at(1) });
    expect(computeFirstSolvers(contest, [late, early, outside, wa])).toEqual([
      { problemId: A, userId: uuid(2), submissionId: early.submissionId, submittedAt: at(20) },
    ]);
  });
});
