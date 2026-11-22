import { useQuery, useSubscription } from '@apollo/client/react';
import { Link, useParams } from 'react-router';
import { Markdown } from '../components/Markdown';
import {
  Alert,
  Card,
  DifficultyBadge,
  EmptyState,
  ErrorState,
  LoadingState,
  Pagination,
  cx,
} from '../components/ui';
import type { ContestQuery, ScoreboardQuery } from '../gen/graphql';
import { CONTEST, SCOREBOARD, SCOREBOARD_UPDATED } from '../graphql/operations';
import { formatDateTime, formatDuration } from '../lib/format';
import { useDebouncedCallback, useNow, usePageTokens } from '../lib/hooks';
import { ContestStatusBadge } from './ContestsPage';

type Contest = NonNullable<ContestQuery['contest']>;
type Row = ScoreboardQuery['scoreboard']['items'][number];

/** Las señales `scoreboardUpdated` seguidas se agrupan en una sola recarga. */
export const SCOREBOARD_DEBOUNCE_MS = 1500;
export const SCOREBOARD_PAGE_SIZE = 50;

export function ContestDetailPage() {
  const { id = '' } = useParams();
  const { data, loading, error, refetch } = useQuery(CONTEST, { variables: { id } });

  if (loading && !data) return <LoadingState label="Cargando contest…" />;
  if (error && !data) return <ErrorState error={error} onRetry={() => void refetch()} />;
  const contest = data?.contest;
  if (!contest)
    return (
      <EmptyState
        title="Contest no encontrado"
        action={
          <Link className="link" to="/contests">
            Ver contests
          </Link>
        }
      />
    );

  return (
    <div className="flex flex-col gap-6">
      <ContestHeader contest={contest} />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <ContestProblems contest={contest} />
        <ScoreboardSection contest={contest} />
      </div>
    </div>
  );
}

function ContestHeader({ contest }: { contest: Contest }) {
  const now = useNow(1000);
  const start = Date.parse(contest.startTime);
  const end = Date.parse(contest.endTime);
  let timer: string | null = null;
  if (now < start) timer = `Empieza en ${formatDuration(start - now)}`;
  else if (now < end) timer = `Termina en ${formatDuration(end - now)}`;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{contest.title}</h1>
        <ContestStatusBadge status={contest.status} />
        {timer && (
          <span className="font-mono text-sm text-zinc-600 dark:text-zinc-400">{timer}</span>
        )}
      </div>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        {formatDateTime(contest.startTime)} → {formatDateTime(contest.endTime)}
      </p>
      {contest.description && (
        <div className="mt-3 text-sm">
          <Markdown>{contest.description}</Markdown>
        </div>
      )}
    </div>
  );
}

function ContestProblems({ contest }: { contest: Contest }) {
  const running = contest.status === 'RUNNING';
  return (
    <section aria-label="Problemas del contest" className="min-w-0">
      <h2 className="mb-2 text-lg font-semibold">Problemas</h2>
      <Card>
        <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {contest.problems.map((p) => (
            <li key={p.letter} className="flex items-center gap-3 px-4 py-2.5">
              <span className="grid size-7 shrink-0 place-items-center rounded-md bg-zinc-100 font-mono text-sm font-semibold dark:bg-zinc-800">
                {p.letter}
              </span>
              {p.problem ? (
                <>
                  <Link
                    className="min-w-0 flex-1 truncate text-sm font-medium hover:text-brand-600"
                    to={`/problems/${p.problem.slug}${running ? `?contest=${contest.id}` : ''}`}
                  >
                    {p.problem.title}
                  </Link>
                  <DifficultyBadge difficulty={p.problem.difficulty} />
                </>
              ) : (
                <span className="text-sm text-zinc-500">No disponible</span>
              )}
            </li>
          ))}
        </ul>
      </Card>
      {contest.status === 'UPCOMING' && (
        <p className="mt-2 text-xs text-zinc-500">
          Podrás enviar soluciones cuando el contest empiece.
        </p>
      )}
    </section>
  );
}

function ScoreboardSection({ contest }: { contest: Contest }) {
  const pages = usePageTokens();
  const { data, previousData, loading, error, refetch } = useQuery(SCOREBOARD, {
    variables: {
      contestId: contest.id,
      pageSize: SCOREBOARD_PAGE_SIZE,
      pageToken: pages.pageToken,
    },
    notifyOnNetworkStatusChange: true,
  });
  const reload = useDebouncedCallback(() => void refetch(), SCOREBOARD_DEBOUNCE_MS);
  const { error: liveError } = useSubscription(SCOREBOARD_UPDATED, {
    variables: { contestId: contest.id },
    skip: contest.status === 'UPCOMING',
    onData: () => reload(),
  });
  const board = (data ?? previousData)?.scoreboard;

  let body;
  if (error && !board) body = <ErrorState error={error} onRetry={() => void refetch()} />;
  else if (!board) body = <LoadingState label="Cargando scoreboard…" />;
  else if (board.items.length === 0)
    body = (
      <EmptyState
        title="Todavía no hay participantes"
        description="Aparecerán con su primer envío."
      />
    );
  else
    body = (
      <>
        <ScoreboardTable rows={board.items} letters={contest.problems.map((p) => p.letter)} />
        <Pagination
          page={pages.page}
          hasPrevious={pages.hasPrevious}
          hasNext={!!board.nextPageToken}
          loading={loading}
          onPrevious={pages.previous}
          onNext={() => board.nextPageToken && pages.next(board.nextPageToken)}
        />
      </>
    );

  return (
    <section aria-label="Scoreboard" className="min-w-0">
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <h2 className="text-lg font-semibold">Scoreboard</h2>
        {board?.updatedAt && (
          <span className="text-xs text-zinc-500">
            Actualizado: {formatDateTime(board.updatedAt)}
          </span>
        )}
        {loading && board && <span className="text-xs text-zinc-500">Actualizando…</span>}
      </div>
      {liveError && (
        <div className="mb-3">
          <Alert tone="warning">Sin conexión en vivo: recarga la página para ver cambios.</Alert>
        </div>
      )}
      {body}
    </section>
  );
}

function Cell({ result }: { result: Row['problems'][number] | undefined }) {
  if (!result || result.attempts === 0)
    return <span className="text-zinc-300 dark:text-zinc-700">·</span>;
  if (result.solved)
    return (
      <span
        className={cx(
          'inline-flex flex-col items-center rounded-md px-1.5 py-0.5 leading-tight',
          result.firstToSolve
            ? 'bg-emerald-600 text-white'
            : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300',
        )}
        title={result.firstToSolve ? 'Primero en resolverlo' : undefined}
      >
        <span className="font-semibold">+{result.attempts > 1 ? result.attempts - 1 : ''}</span>
        <span className="text-[10px]">{result.solvedAtMinute}′</span>
      </span>
    );
  return (
    <span className="inline-flex rounded-md bg-red-100 px-1.5 py-0.5 font-semibold text-red-700 dark:bg-red-900/40 dark:text-red-300">
      −{result.attempts}
    </span>
  );
}

function ScoreboardTable({ rows, letters }: { rows: Row[]; letters: string[] }) {
  return (
    <Card>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-zinc-200 text-xs text-zinc-500 dark:border-zinc-800">
            <tr>
              <th className="px-3 py-2 text-left font-medium">#</th>
              <th className="px-3 py-2 text-left font-medium">Participante</th>
              <th className="px-3 py-2 text-center font-medium" title="Resueltos">
                Res.
              </th>
              <th className="px-3 py-2 text-center font-medium" title="Penalización (minutos)">
                Pen.
              </th>
              {letters.map((l) => (
                <th key={l} className="px-2 py-2 text-center font-mono font-medium">
                  {l}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {rows.map((row) => (
              <tr key={row.userId}>
                <td className="px-3 py-2 font-mono">{row.rank}</td>
                <td className="max-w-[12rem] truncate px-3 py-2 font-medium">{row.username}</td>
                <td className="px-3 py-2 text-center font-semibold">{row.solved}</td>
                <td className="px-3 py-2 text-center font-mono">{row.penaltyMinutes}</td>
                {letters.map((l) => (
                  <td key={l} className="px-2 py-2 text-center text-xs">
                    <Cell result={row.problems.find((p) => p.letter === l)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
