import { useApolloClient } from '@apollo/client/react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Role } from '../gen/graphql';
import { ME } from '../graphql/operations';
import { errorCode } from './errors';
import { clearSession, loadSession, saveSession, type Session } from './session';

/** Evento global que emite el link de errores de Apollo ante `UNAUTHENTICATED`. */
export const UNAUTHENTICATED_EVENT = 'juez:unauthenticated';

export interface AuthContextValue {
  session: Session | null;
  user: Session['user'] | null;
  signIn: (session: Session) => void;
  signOut: () => Promise<void>;
  hasRole: (...roles: Role[]) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export interface AuthProviderProps {
  children: ReactNode;
  /** Se llama al iniciar o cerrar sesión (p. ej. para reabrir el WebSocket con el token nuevo). */
  onSessionChange?: () => void;
}

export function AuthProvider({ children, onSessionChange }: AuthProviderProps) {
  const client = useApolloClient();
  const [session, setSession] = useState<Session | null>(() => loadSession());

  const signIn = useCallback(
    (next: Session) => {
      saveSession(next);
      setSession(next);
      onSessionChange?.();
    },
    [onSessionChange],
  );

  const signOut = useCallback(async () => {
    clearSession();
    setSession(null);
    onSessionChange?.();
    // clearStore borra la cache sin volver a ejecutar las queries activas.
    await client.clearStore();
  }, [client, onSessionChange]);

  // Revalida la sesión guardada con `me` cuando cambia el token (y refresca el rol si cambió).
  const token = session?.token;
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    client.query({ query: ME, fetchPolicy: 'network-only' }).then(
      ({ data }) => {
        if (cancelled || !data) return;
        const me = data.me;
        setSession((prev) => {
          if (!prev || prev.token !== token) return prev;
          const same =
            prev.user.id === me.id &&
            prev.user.role === me.role &&
            prev.user.username === me.username;
          if (same) return prev;
          const updated: Session = { ...prev, user: { ...prev.user, ...me } };
          saveSession(updated);
          return updated;
        });
      },
      (err: unknown) => {
        if (!cancelled && errorCode(err) === 'UNAUTHENTICATED') void signOut();
      },
    );
    return () => {
      cancelled = true;
    };
  }, [token, client, signOut]);

  // Cierre automático al vencer el token.
  useEffect(() => {
    if (!session) return;
    const remaining = Date.parse(session.expiresAt) - Date.now();
    const timer = setTimeout(() => void signOut(), Math.max(0, Math.min(remaining, 2 ** 31 - 1)));
    return () => clearTimeout(timer);
  }, [session, signOut]);

  // Token rechazado por el servidor y logout desde otra pestaña.
  useEffect(() => {
    const onUnauthenticated = () => void signOut();
    const onStorage = (event: StorageEvent) => {
      if (event.key === 'juez.session' && event.newValue === null && session) void signOut();
    };
    window.addEventListener(UNAUTHENTICATED_EVENT, onUnauthenticated);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(UNAUTHENTICATED_EVENT, onUnauthenticated);
      window.removeEventListener('storage', onStorage);
    };
  }, [session, signOut]);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      signIn,
      signOut,
      hasRole: (...roles) => !!session && roles.includes(session.user.role),
    }),
    [session, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth debe usarse dentro de <AuthProvider>');
  return value;
}
