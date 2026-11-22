import { useMutation, useQuery } from '@apollo/client/react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { CodeEditor } from '../components/CodeEditor';
import { Markdown } from '../components/Markdown';
import {
  Alert,
  Badge,
  Button,
  Card,
  DifficultyBadge,
  EmptyState,
  ErrorState,
  LoadingState,
} from '../components/ui';
import type { Language, ProblemQuery } from '../gen/graphql';
import { PROBLEM, SUBMIT } from '../graphql/operations';
import { useAuth } from '../lib/auth';
import { loadDraft, saveDraft } from '../lib/drafts';
import { describeError } from '../lib/errors';
import { LANGUAGE_LABELS, LANGUAGES } from '../lib/format';
import { useDebouncedCallback } from '../lib/hooks';

type Problem = NonNullable<ProblemQuery['problem']>;

export function ProblemDetailPage() {
  const { slug = '' } = useParams();
  const { data, loading, error, refetch } = useQuery(PROBLEM, { variables: { slug } });

  if (loading && !data) return <LoadingState label="Cargando problema…" />;
  if (error && !data) return <ErrorState error={error} onRetry={() => void refetch()} />;
  const problem = data?.problem;
  if (!problem)
    return (
      <EmptyState
        title="Problema no encontrado"
        description="No existe o todavía no está publicado."
        action={
          <Link className="link" to="/problems">
            Volver a los problemas
          </Link>
        }
      />
    );

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-2">
      <Statement problem={problem} />
      <SubmitPanel problem={problem} />
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="text-xs text-zinc-500 hover:text-brand-600"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? 'Copiado' : 'Copiar'}
    </button>
  );
}

function Statement({ problem }: { problem: Problem }) {
  const { user, hasRole } = useAuth();
  const canEdit = hasRole('ADMIN') || (hasRole('SETTER') && user?.id === problem.authorId);
  return (
    <article className="min-w-0">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-2xl font-semibold tracking-tight">{problem.title}</h1>
        {canEdit && (
          <Link className="link text-sm" to={`/admin/problems/${problem.slug}/edit`}>
            Editar
          </Link>
        )}
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <DifficultyBadge difficulty={problem.difficulty} />
        {!problem.published && (
          <Badge className="bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
            Borrador
          </Badge>
        )}
        <span className="text-zinc-600 dark:text-zinc-400">⏱ {problem.timeLimitMs} ms</span>
        <span className="text-zinc-600 dark:text-zinc-400">💾 {problem.memoryLimitMb} MB</span>
        {problem.tags.map((t) => (
          <Link
            key={t}
            to={`/problems?tags=${encodeURIComponent(t)}`}
            className="rounded-md bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
          >
            #{t}
          </Link>
        ))}
      </div>
      <Card className="p-5">
        <Markdown>{problem.statement}</Markdown>
        {problem.examples.length > 0 && (
          <section className="mt-6">
            <h2 className="mb-3 text-lg font-semibold">Ejemplos</h2>
            <div className="flex flex-col gap-4">
              {problem.examples.map((ex, i) => (
                <div key={i} className="rounded-lg border border-zinc-200 dark:border-zinc-800">
                  <div className="grid sm:grid-cols-2">
                    <div className="border-b border-zinc-200 p-3 sm:border-r sm:border-b-0 dark:border-zinc-800">
                      <div className="mb-1 flex justify-between text-xs font-medium text-zinc-500">
                        Entrada {i + 1} <CopyButton text={ex.input} />
                      </div>
                      <pre className="code-block">{ex.input}</pre>
                    </div>
                    <div className="p-3">
                      <div className="mb-1 flex justify-between text-xs font-medium text-zinc-500">
                        Salida {i + 1} <CopyButton text={ex.output} />
                      </div>
                      <pre className="code-block">{ex.output}</pre>
                    </div>
                  </div>
                  {ex.explanation && (
                    <div className="border-t border-zinc-200 p-3 text-sm dark:border-zinc-800">
                      <Markdown>{ex.explanation}</Markdown>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}
      </Card>
    </article>
  );
}

function SubmitPanel({ problem }: { problem: Problem }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const contestId = params.get('contest');
  const [language, setLanguage] = useState<Language>('CPP17');
  const [code, setCode] = useState(() => loadDraft(problem.id, 'CPP17'));
  const [error, setError] = useState<string | null>(null);
  const [submit, { loading }] = useMutation(SUBMIT);
  const persist = useDebouncedCallback(saveDraft, 500);
  const latest = useRef({ language, code });

  // Al salir de la pantalla se guarda lo último escrito (el guardado con debounce se cancela).
  useEffect(() => {
    latest.current = { language, code };
  }, [language, code]);
  useEffect(
    () => () => saveDraft(problem.id, latest.current.language, latest.current.code),
    [problem.id],
  );

  const changeLanguage = (next: Language) => {
    setLanguage(next);
    setCode(loadDraft(problem.id, next));
  };

  const onChange = (value: string) => {
    setCode(value);
    persist(problem.id, language, value);
  };

  const onSubmit = async () => {
    setError(null);
    saveDraft(problem.id, language, code);
    try {
      const { data } = await submit({
        variables: {
          input: {
            problemId: problem.id,
            language,
            sourceCode: code,
            ...(contestId ? { contestId } : {}),
          },
        },
      });
      if (data) navigate(`/submissions/${data.submit.id}`);
    } catch (err) {
      const d = describeError(err, {
        NOT_FOUND: 'El problema o el contest ya no existe.',
        BAD_USER_INPUT:
          'No se pudo enviar: el contest no está en curso o no incluye este problema.',
      });
      setError(d.message);
    }
  };

  return (
    <section aria-label="Enviar solución" className="min-w-0 lg:sticky lg:top-20 lg:self-start">
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="mr-auto text-lg font-semibold">Tu solución</h2>
          <label htmlFor="language" className="sr-only">
            Lenguaje
          </label>
          <select
            id="language"
            value={language}
            onChange={(e) => changeLanguage(e.target.value as Language)}
            className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          >
            {LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {LANGUAGE_LABELS[l]}
              </option>
            ))}
          </select>
        </div>
        {contestId && (
          <Alert tone="info">
            Envío dentro del contest.{' '}
            <Link className="link" to={`/contests/${contestId}`}>
              Volver al contest
            </Link>
          </Alert>
        )}
        <CodeEditor
          value={code}
          onChange={onChange}
          language={language}
          ariaLabel="Código fuente"
        />
        {error && <Alert>{error}</Alert>}
        {user ? (
          <Button onClick={onSubmit} loading={loading} disabled={!code.trim()}>
            Enviar solución
          </Button>
        ) : (
          <Alert tone="info">
            <Link
              className="link"
              to={`/login?next=${encodeURIComponent(`/problems/${problem.slug}`)}`}
            >
              Inicia sesión
            </Link>{' '}
            para enviar tu solución.
          </Alert>
        )}
      </Card>
    </section>
  );
}
