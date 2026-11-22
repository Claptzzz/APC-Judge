import { afterEach, describe, expect, it } from 'vitest';
import { makeSession } from '../test/fixtures';
import { clearSession, currentToken, isExpired, loadSession, saveSession } from './session';

describe('session', () => {
  afterEach(() => localStorage.clear());

  it('guarda y lee la sesión en localStorage', () => {
    const s = makeSession();
    saveSession(s);
    expect(loadSession()).toEqual(s);
    expect(currentToken()).toBe(s.token);
    clearSession();
    expect(loadSession()).toBeNull();
    expect(currentToken()).toBeNull();
  });

  it('descarta sesiones vencidas o corruptas', () => {
    saveSession({ ...makeSession(), expiresAt: '2000-01-01T00:00:00.000Z' });
    expect(loadSession()).toBeNull();
    expect(localStorage.getItem('juez.session')).toBeNull();
    localStorage.setItem('juez.session', '{no json');
    expect(loadSession()).toBeNull();
    localStorage.setItem('juez.session', JSON.stringify({ token: 1 }));
    expect(loadSession()).toBeNull();
  });

  it('isExpired', () => {
    expect(isExpired({ ...makeSession(), expiresAt: 'x' })).toBe(true);
    expect(isExpired(makeSession())).toBe(false);
  });
});
