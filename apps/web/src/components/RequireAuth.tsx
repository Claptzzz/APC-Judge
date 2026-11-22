import type { ReactNode } from 'react';
import { Link, Navigate, useLocation } from 'react-router';
import type { Role } from '../gen/graphql';
import { useAuth } from '../lib/auth';
import { EmptyState } from './ui';

/**
 * Protege una ruta: sin sesión redirige al login (y vuelve después); con un rol insuficiente
 * muestra un aviso en vez de la pantalla.
 */
export function RequireAuth({ roles, children }: { roles?: Role[]; children: ReactNode }) {
  const { user } = useAuth();
  const location = useLocation();

  if (!user) {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  if (roles && !roles.includes(user.role)) {
    return (
      <EmptyState
        title="No tienes acceso a esta sección"
        description="Esta pantalla es solo para autores de problemas y administradores."
        action={
          <Link className="link" to="/problems">
            Volver a los problemas
          </Link>
        }
      />
    );
  }
  return <>{children}</>;
}
