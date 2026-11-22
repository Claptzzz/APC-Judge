import { useQuery } from '@apollo/client/react';
import { Link, useSearchParams } from 'react-router';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Pagination,
  cx,
} from '../components/ui';
import type { ContestStatus } from '../gen/graphql';
import { CONTESTS } from '../graphql/operations';
import { useAuth } from '../lib/auth';
import { CONTEST_STATUS_LABELS, formatDateTime } from '../lib/format';
import { usePageTokens } from '../lib/hooks';

const STATUSES: ContestStatus[] = ['RUNNING', 'UPCOMING', 'FINISHED'];

export const STATUS_STYLES: Record<ContestStatus, string> = {
  RUNNING: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  UPCOMING: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300',
  FINISHED: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
};

export function ContestStatusBadge({ status }: { status: ContestStatus }) {
  return (
    <Badge className={STATUS_STYLES[status]}>
      {status === 'RUNNING' && (
        <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
      )}
      {CONTEST_STATUS_LABELS[status]}
    </Badge>
  );
}

export function ContestsPage() {
  const { hasRole } = useAuth();
  const [params, setParams] = useSearchParams();
  const raw = params.get('status');
  const status = STATUSES.includes(raw as ContestStatus) ? (raw as ContestStatus) : null;

  const tabs: Array<{ value: ContestStatus | null; label: string }> = [
    { value: null, label: 'Todos' },
    ...STATUSES.map((s) => ({ value: s, label: CONTEST_STATUS_LABELS[s] })),
  ];

  return (
    <>
      <PageHeader
        title="Contests"
        subtitle="Competencias con scoreboard estilo ICPC."
        actions={
          hasRole('SETTER', 'ADMIN') && (
            <Link
              to="/admin/contests/new"
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
            >
              Nuevo contest
            </Link>
          )
        }
      />
      <div role="tablist" aria-label="Estado" className="mb-4 flex gap-1 overflow-x-auto">
        {tabs.map((t) => (
          <button
            key={t.label}
            role="tab"
            type="button"
            aria-selected={status === t.value}
            onClick={() => setParams(t.value ? { status: t.value } : {}, { replace: true })}
            className={cx(
              'rounded-lg px-3 py-1.5 text-sm font-medium whitespace-nowrap',
              status === t.value
                ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <ContestList key={status ?? 'all'} status={status} />
    </>
  );
}

function ContestList({ status }: { status: ContestStatus | null }) {
  const pages = usePageTokens();
  const { data, previousData, loading, error, refetch } = useQuery(CONTESTS, {
    variables: { status, pageSize: 20, pageToken: pages.pageToken },
    notifyOnNetworkStatusChange: true,
  });
  const page = (data ?? previousData)?.contests;

  if (error && !page) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (!page) return <LoadingState label="Cargando contests…" />;
  if (page.items.length === 0)
    return (
      <EmptyState
        title="No hay contests"
        description={status ? 'Prueba con otro estado.' : undefined}
      />
    );

  return (
    <>
      <div className={cx('grid gap-3 sm:grid-cols-2', loading && 'opacity-60')}>
        {page.items.map((c) => (
          <Link key={c.id} to={`/contests/${c.id}`} className="group">
            <Card className="h-full p-4 transition-colors group-hover:border-brand-400">
              <div className="mb-2 flex items-start justify-between gap-2">
                <h2 className="font-semibold group-hover:text-brand-600">{c.title}</h2>
                <ContestStatusBadge status={c.status} />
              </div>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                {formatDateTime(c.startTime)} → {formatDateTime(c.endTime)}
              </p>
              <p className="mt-1 text-xs text-zinc-500">{c.problems.length} problemas</p>
            </Card>
          </Link>
        ))}
      </div>
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
}
