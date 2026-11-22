import { Link } from 'react-router';
import { EmptyState } from '../components/ui';

export function NotFoundPage() {
  return (
    <EmptyState
      title="Página no encontrada"
      description="La dirección no existe o cambió."
      action={
        <Link className="link" to="/problems">
          Ir a los problemas
        </Link>
      }
    />
  );
}
