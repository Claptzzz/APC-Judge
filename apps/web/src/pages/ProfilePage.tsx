import { useQuery } from '@apollo/client/react';
import { Card, ErrorState, LoadingState, PageHeader, VerdictBadge } from '../components/ui';
import { USER_STATS } from '../graphql/operations';
import { useAuth } from '../lib/auth';
import { ROLE_LABELS } from '../lib/format';

export function ProfilePage() {
  const { user } = useAuth();
  const { data, loading, error, refetch } = useQuery(USER_STATS, {
    fetchPolicy: 'cache-and-network',
  });
  const stats = data?.userStats;

  return (
    <>
      <PageHeader
        title={user?.username ?? 'Mi perfil'}
        subtitle={
          user ? `${ROLE_LABELS[user.role]}${user.email ? ` · ${user.email}` : ''}` : undefined
        }
      />
      {loading && !stats ? (
        <LoadingState label="Cargando estadísticas…" />
      ) : error && !stats ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : stats ? (
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              { label: 'Problemas resueltos', value: stats.solvedCount },
              { label: 'Problemas intentados', value: stats.attemptedCount },
              { label: 'Envíos juzgados', value: stats.totalSubmissions },
            ].map((s) => (
              <Card key={s.label} className="p-4">
                <p className="text-sm text-zinc-500">{s.label}</p>
                <p className="text-3xl font-semibold">{s.value}</p>
              </Card>
            ))}
          </div>
          {stats.verdictCounts.length > 0 && (
            <Card className="p-4">
              <h2 className="mb-3 font-semibold">Veredictos</h2>
              <ul className="flex flex-wrap gap-3">
                {stats.verdictCounts.map((v) => (
                  <li key={v.verdict} className="flex items-center gap-2 text-sm">
                    <VerdictBadge verdict={v.verdict} />
                    <span className="font-mono">{v.count}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      ) : null}
    </>
  );
}
