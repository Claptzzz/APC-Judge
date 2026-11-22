import { useQuery, useSubscription } from '@apollo/client/react';
import { useEffect } from 'react';
import { Link, useParams } from 'react-router';
import { CodeEditor } from '../components/CodeEditor';
import { Alert, Card, EmptyState, ErrorState, LoadingState, Spinner, cx } from '../components/ui';
import type { SubmissionQuery, Verdict } from '../gen/graphql';
import { SUBMISSION, SUBMISSION_UPDATED } from '../graphql/operations';
import {
  formatDateTime,
  formatMemory,
  formatMs,
  isFinalVerdict,
  LANGUAGE_LABELS,
  VERDICT_LABELS,
} from '../lib/format';

type Submission = NonNullable<SubmissionQuery['submission']>;

/** Si la subscription falla (p. ej. el WebSocket no conecta), se consulta cada 3 s. */
export const FALLBACK_POLL_MS = 3000;

const WAITING_TEXT: Partial<Record<Verdict, { title: string; body: string }>> = {
  PENDING: {
    title: 'En cola',
    body: 'Tu solución espera un juez disponible. El veredicto aparecerá aquí automáticamente.',
  },
  JUDGING: {
    title: 'Evaluando',
    body: 'El juez está compilando y ejecutando tu solución contra los casos de prueba.',
  },
};

export function SubmissionPage() {
  const { id = '' } = useParams();
  const { data, loading, error, refetch, startPolling, stopPolling } = useQuery(SUBMISSION, {
    variables: { id },
  });
  const submission = data?.submission;
  const waiting = !!submission && !isFinalVerdict(submission.verdict);

  // Emite el tipo Submission con su id: la cache actualiza esta query sola.
  const { error: liveError } = useSubscription(SUBMISSION_UPDATED, {
    variables: { id },
    skip: !waiting,
  });

  useEffect(() => {
    if (waiting && liveError) startPolling(FALLBACK_POLL_MS);
    else stopPolling();
  }, [waiting, liveError, startPolling, stopPolling]);

  if (loading && !data) return <LoadingState label="Cargando envío…" />;
  if (error && !data) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (!submission)
    return (
      <EmptyState
        title="Envío no encontrado"
        action={
          <Link className="link" to="/submissions">
            Ver mis envíos
          </Link>
        }
      />
    );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          Envío{' '}
          <span className="font-mono text-base text-zinc-500" title={submission.id}>
            #{submission.id.slice(0, 8)}
          </span>
        </h1>
        {submission.problem ? (
          <Link className="link" to={`/problems/${submission.problem.slug}`}>
            {submission.problem.title}
          </Link>
        ) : (
          <span className="text-sm text-zinc-500">Problema no disponible</span>
        )}
        {submission.contest && (
          <Link className="link text-sm" to={`/contests/${submission.contest.id}`}>
            Contest: {submission.contest.title}
          </Link>
        )}
      </div>

      <VerdictPanel submission={submission} />
      {waiting && liveError && (
        <Alert tone="warning">
          No pudimos abrir la conexión en vivo; consultaremos el estado cada pocos segundos.
        </Alert>
      )}

      <Card className="p-4">
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <Meta label="Lenguaje" value={LANGUAGE_LABELS[submission.language]} />
          <Meta label="Enviado" value={formatDateTime(submission.submittedAt)} />
          <Meta label="Juzgado" value={formatDateTime(submission.judgedAt)} />
          <Meta label="Autor" value={submission.user?.username ?? '—'} />
        </dl>
      </Card>

      {submission.sourceCode !== null && submission.sourceCode !== undefined && (
        <section>
          <h2 className="mb-2 text-lg font-semibold">Código</h2>
          <CodeEditor
            value={submission.sourceCode}
            language={submission.language}
            readOnly
            ariaLabel="Código enviado"
            minHeight="120px"
          />
        </section>
      )}
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function VerdictPanel({ submission }: { submission: Submission }) {
  const waiting = WAITING_TEXT[submission.verdict];
  if (waiting) {
    return (
      <Card className="overflow-hidden">
        <div role="status" aria-live="polite" className="flex items-start gap-4 p-5">
          <Spinner className="mt-0.5 size-6 text-sky-600" />
          <div>
            <p className="text-lg font-semibold">{waiting.title}…</p>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">{waiting.body}</p>
          </div>
        </div>
        <div className="h-1 w-full overflow-hidden bg-sky-100 dark:bg-sky-950">
          <div
            className={cx(
              'h-full bg-sky-500',
              submission.verdict === 'PENDING' ? 'w-1/4 animate-pulse' : 'progress-indeterminate',
            )}
          />
        </div>
      </Card>
    );
  }

  const accepted = submission.verdict === 'ACCEPTED';
  const cases =
    submission.passedCases !== null && submission.totalCases !== null
      ? `${submission.passedCases} / ${submission.totalCases}`
      : '—';
  return (
    <Card
      className={cx(
        'p-5',
        accepted
          ? 'border-emerald-300 dark:border-emerald-800'
          : 'border-red-200 dark:border-red-900/70',
      )}
    >
      <div
        role="status"
        aria-live="polite"
        className="flex flex-col gap-4 sm:flex-row sm:items-center"
      >
        <div className="flex-1">
          <p className="text-xs uppercase tracking-wide text-zinc-500">Veredicto</p>
          <p
            className={cx(
              'text-2xl font-bold',
              accepted
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-red-600 dark:text-red-400',
            )}
          >
            {VERDICT_LABELS[submission.verdict]}
          </p>
          {submission.verdict === 'INTERNAL_ERROR' && (
            <p className="text-sm text-zinc-500">
              Falla del juez, no de tu solución. Intenta enviarla de nuevo.
            </p>
          )}
        </div>
        <dl className="grid grid-cols-3 gap-4 text-sm">
          <div>
            <dt className="text-xs text-zinc-500">Tiempo</dt>
            <dd className="font-mono">{formatMs(submission.timeMs)}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500">Memoria</dt>
            <dd className="font-mono">{formatMemory(submission.memoryKb)}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500">Casos</dt>
            <dd className="font-mono">{cases}</dd>
          </div>
        </dl>
      </div>
    </Card>
  );
}
