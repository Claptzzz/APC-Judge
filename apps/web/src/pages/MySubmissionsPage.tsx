import { useQuery } from '@apollo/client/react';
import { Link } from 'react-router';
import {
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Pagination,
  VerdictBadge,
} from '../components/ui';
import { SUBMISSIONS } from '../graphql/operations';
import { useAuth } from '../lib/auth';
import { formatDateTime, formatMemory, formatMs, LANGUAGE_LABELS } from '../lib/format';
import { usePageTokens } from '../lib/hooks';

export const SUBMISSIONS_PAGE_SIZE = 20;

export function MySubmissionsPage() {
  const { user } = useAuth();
  const pages = usePageTokens();
  const { data, previousData, loading, error, refetch } = useQuery(SUBMISSIONS, {
    variables: {
      filter: { userId: user?.id ?? '' },
      pageSize: SUBMISSIONS_PAGE_SIZE,
      pageToken: pages.pageToken,
    },
    skip: !user,
    fetchPolicy: 'cache-and-network',
    notifyOnNetworkStatusChange: true,
  });
  const page = (data ?? previousData)?.submissions;

  let body;
  if (error && !page) body = <ErrorState error={error} onRetry={() => void refetch()} />;
  else if (!page) body = <LoadingState label="Cargando tus envíos…" />;
  else if (page.items.length === 0)
    body = (
      <EmptyState
        title="Aún no tienes envíos"
        description="Elige un problema y envía tu primera solución."
        action={
          <Link className="link" to="/problems">
            Ir a los problemas
          </Link>
        }
      />
    );
  else
    body = (
      <>
        <Card className={loading ? 'opacity-60 transition-opacity' : undefined}>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-zinc-200 text-xs uppercase text-zinc-500 dark:border-zinc-800">
                <tr>
                  <th className="px-4 py-2 font-medium">Problema</th>
                  <th className="px-4 py-2 font-medium">Veredicto</th>
                  <th className="hidden px-4 py-2 font-medium sm:table-cell">Lenguaje</th>
                  <th className="hidden px-4 py-2 font-medium md:table-cell">Tiempo</th>
                  <th className="hidden px-4 py-2 font-medium md:table-cell">Memoria</th>
                  <th className="px-4 py-2 font-medium">Enviado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {page.items.map((s) => (
                  <tr key={s.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                    <td className="px-4 py-2">
                      <Link
                        className="font-medium hover:text-brand-600"
                        to={`/submissions/${s.id}`}
                      >
                        {s.problem?.title ?? 'Problema no disponible'}
                      </Link>
                      {s.contestId && <span className="ml-2 text-xs text-zinc-500">(contest)</span>}
                    </td>
                    <td className="px-4 py-2">
                      <VerdictBadge verdict={s.verdict} />
                    </td>
                    <td className="hidden px-4 py-2 sm:table-cell">
                      {LANGUAGE_LABELS[s.language]}
                    </td>
                    <td className="hidden px-4 py-2 font-mono md:table-cell">
                      {formatMs(s.timeMs)}
                    </td>
                    <td className="hidden px-4 py-2 font-mono md:table-cell">
                      {formatMemory(s.memoryKb)}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap text-zinc-600 dark:text-zinc-400">
                      {formatDateTime(s.submittedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Pagination
          page={pages.page}
          hasPrevious={pages.hasPrevious}
          hasNext={!!page.nextPageToken}
          loading={loading}
          onPrevious={pages.previous}
          onNext={() => page.nextPageToken && pages.next(page.nextPageToken)}
        />
      </>
    );

  return (
    <>
      <PageHeader
        title="Mis envíos"
        subtitle="Tus soluciones, de la más reciente a la más antigua."
      />
      {body}
    </>
  );
}
