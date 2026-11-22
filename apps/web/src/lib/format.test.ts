import { describe, expect, it } from 'vitest';
import {
  formatDateTime,
  formatDuration,
  formatMemory,
  formatMs,
  isFinalVerdict,
  localInputToIso,
} from './format';

describe('format', () => {
  it('veredictos finales', () => {
    expect(isFinalVerdict('PENDING')).toBe(false);
    expect(isFinalVerdict('JUDGING')).toBe(false);
    expect(isFinalVerdict('ACCEPTED')).toBe(true);
    expect(isFinalVerdict('COMPILATION_ERROR')).toBe(true);
  });

  it('memoria y tiempo', () => {
    expect(formatMemory(null)).toBe('—');
    expect(formatMemory(512)).toBe('512 KB');
    expect(formatMemory(2048)).toBe('2.0 MB');
    expect(formatMs(undefined)).toBe('—');
    expect(formatMs(15)).toBe('15 ms');
  });

  it('duraciones', () => {
    expect(formatDuration(30_000)).toBe('30 s');
    expect(formatDuration(45 * 60_000)).toBe('45 min');
    expect(formatDuration(2 * 3600_000 + 5 * 60_000)).toBe('2 h 05 min');
    expect(formatDuration(3 * 86400_000 + 3600_000)).toBe('3 d 1 h');
    expect(formatDuration(-5)).toBe('0 s');
  });

  it('fechas', () => {
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime('no-es-fecha')).toBe('—');
    expect(formatDateTime('2026-11-22T15:04:05.123Z')).toMatch(/2026/);
    expect(localInputToIso('')).toBeNull();
    expect(localInputToIso('xx')).toBeNull();
    expect(localInputToIso('2026-11-22T15:00')).toMatch(/^2026-11-2\dT\d\d:00:00\.000Z$/);
  });
});
