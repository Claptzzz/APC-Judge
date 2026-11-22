import type { Role } from '../gen/graphql';

export interface SessionUser {
  id: string;
  username: string;
  email?: string | null;
  role: Role;
}

export interface Session {
  token: string;
  expiresAt: string;
  user: SessionUser;
}

const STORAGE_KEY = 'juez.session';

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function isSession(value: unknown): value is Session {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const user = v.user as Record<string, unknown> | undefined;
  return (
    typeof v.token === 'string' &&
    typeof v.expiresAt === 'string' &&
    !!user &&
    typeof user.id === 'string' &&
    typeof user.username === 'string' &&
    typeof user.role === 'string'
  );
}

export function isExpired(session: Session, now = Date.now()): boolean {
  const expires = Date.parse(session.expiresAt);
  return Number.isNaN(expires) || expires <= now;
}

/** Sesión guardada y vigente; si está vencida o corrupta, se borra. */
export function loadSession(now = Date.now()): Session | null {
  const raw = storage()?.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isSession(parsed) && !isExpired(parsed, now)) return parsed;
  } catch {
    // JSON corrupto: se descarta abajo.
  }
  clearSession();
  return null;
}

export function saveSession(session: Session): void {
  storage()?.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  storage()?.removeItem(STORAGE_KEY);
}

/** Token actual (lo leen los links de Apollo en cada request y al abrir el WebSocket). */
export function currentToken(): string | null {
  return loadSession()?.token ?? null;
}
