import { describe, expect, it } from 'vitest';
import { contestStatus, isUuid, problemLetter } from '../../src/domain/contest.js';
import { makeContest, minutes } from '../helpers.js';

describe('contest', () => {
  const c = makeContest();
  it('calcula el estado con la hora actual', () => {
    expect(contestStatus(c, minutes(-1))).toBe('UPCOMING');
    expect(contestStatus(c, c.startTime)).toBe('RUNNING');
    expect(contestStatus(c, minutes(299))).toBe('RUNNING');
    expect(contestStatus(c, c.endTime)).toBe('FINISHED');
  });

  it('asigna letras A..Z', () => {
    expect(problemLetter(0)).toBe('A');
    expect(problemLetter(2)).toBe('C');
    expect(problemLetter(25)).toBe('Z');
    expect(() => problemLetter(26)).toThrow(RangeError);
    expect(() => problemLetter(-1)).toThrow(RangeError);
  });

  it('valida UUIDs', () => {
    expect(isUuid('7f9c7c1e-1b2a-4c3d-8e9f-0a1b2c3d4e5f')).toBe(true);
    expect(isUuid('nope')).toBe(false);
  });
});
