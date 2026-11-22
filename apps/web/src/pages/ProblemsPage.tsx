import { useQuery } from '@apollo/client/react';
import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  Badge,
  Button,
  Card,
  DifficultyBadge,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Pagination,
  SelectField,
} from '../components/ui';
import type { Difficulty } from '../gen/graphql';
import { PROBLEMS } from '../graphql/operations';
import { useAuth } from '../lib/auth';
import { DIFFICULTY_LABELS } from '../lib/format';
import { usePageTokens } from '../lib/hooks';

export const PROBLEMS_PAGE_SIZE = 20;
const DIFFICULTIES: Difficulty[] = ['EASY', 'MEDIUM', 'HARD'];

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

function parseDifficulty(raw: string | null): Difficulty | null {
  return DIFFICULTIES.includes(raw as Difficulty) ? (raw as Difficulty) : null;
}

export function ProblemsPage() {
  const { hasRole } = useAuth();
  const [params, setParams] = useSearchParams();
  const tags = parseTags(params.get('tags'));
  const difficulty = parseDifficulty(params.get('difficulty'));
  const [tagInput, setTagInput] = useState('');

  const update = (nextTags: string[], nextDifficulty: Difficulty | null) => {
    const next = new URLSearchParams();
    if (nextTags.length) next.set('tags', nextTags.join(','));
    if (nextDifficulty) next.set('difficulty', nextDifficulty);
    setParams(next, { replace: true });
  };

  const addTag = (tag: string) => {
    const clean = tag.trim().toLowerCase();
    if (clean && !tags.includes(clean)) update([...tags, clean], difficulty);
  };

  const onTagSubmit = (e: FormEvent) => {
    e.preventDefault();
    addTag(tagInput);
    setTagInput('');
  };

  return (
    <>
      <PageHeader
        title="Problemas"
        subtitle="Elige un problema, lee el enunciado y envía tu solución."
        actions={
          hasRole('SETTER', 'ADMIN') && (
            <Link
              to="/admin/problems/new"
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
            >
              Nuevo problema
            </Link>
          )
        }
      />
      <Card className="mb-4 p-4">
        <div className="grid gap-4 sm:grid-cols-[1fr_200px]">
          <form onSubmit={onTagSubmit} className="flex flex-col gap-1.5" role="search">
            <label htmlFor="tag-filter" className="text-sm font-medium">
              Filtrar por tags
            </label>
            <div className="flex gap-2">
              <input
                id="tag-filter"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                placeholder="p. ej. grafos (Enter para agregar)"
                className="block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              />
              <Button type="submit" variant="secondary" disabled={!tagInput.trim()}>
                Agregar
              </Button>
            </div>
          </form>
          <SelectField
            label="Dificultad"
            value={difficulty ?? ''}
            onChange={(e) => update(tags, parseDifficulty(e.target.value))}
          >
            <option value="">Todas</option>
            {DIFFICULTIES.map((d) => (
              <option key={d} value={d}>
                {DIFFICULTY_LABELS[d]}
              </option>
            ))}
          </SelectField>
        </div>
        {(tags.length > 0 || difficulty) && (
          <div className="mt-3 flex flex-wrap items-center gap-2" aria-label="Filtros activos">
            {tags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() =>
                  update(
                    tags.filter((t) => t !== tag),
                    difficulty,
                  )
                }
                className="inline-flex items-center gap-1 rounded-full bg-brand-100 px-2.5 py-1 text-xs font-medium text-brand-800 hover:bg-brand-200 dark:bg-brand-900/50 dark:text-brand-200"
                aria-label={`Quitar tag ${tag}`}
              >
                #{tag} <span aria-hidden>×</span>
              </button>
            ))}
            <button type="button" className="link text-xs" onClick={() => update([], null)}>
              Limpiar filtros
            </button>
          </div>
        )}
      </Card>
      {/* La key reinicia la paginación al cambiar los filtros. */}
      <ProblemList
        key={`${tags.join(',')}|${difficulty ?? ''}`}
        tags={tags}
        difficulty={difficulty}
        onTag={addTag}
      />
    </>
  );
}

function ProblemList({
  tags,
  difficulty,
  onTag,
}: {
  tags: string[];
  difficulty: Difficulty | null;
  onTag: (tag: string) => void;
}) {
  const pages = usePageTokens();
  const filter =
    tags.length || difficulty
      ? { ...(tags.length ? { tags } : {}), ...(difficulty ? { difficulty } : {}) }
      : null;
  const { data, previousData, loading, error, refetch } = useQuery(PROBLEMS, {
    variables: { filter, pageSize: PROBLEMS_PAGE_SIZE, pageToken: pages.pageToken },
    notifyOnNetworkStatusChange: true,
  });
  const page = (data ?? previousData)?.problems;

  if (error && !page) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (!page) return <LoadingState label="Cargando problemas…" />;
  if (page.items.length === 0)
    return (
      <EmptyState
        title="No hay problemas que coincidan"
        description={filter ? 'Prueba quitando algún filtro.' : 'Todavía no se publican problemas.'}
      />
    );

  return (
    <>
      <Card className={loading ? 'opacity-60 transition-opacity' : undefined}>
        <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {page.items.map((p) => (
            <li
              key={p.id}
              className="flex flex-col items-start gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
            >
              <div className="min-w-0 flex-1">
                <Link
                  to={`/problems/${p.slug}`}
                  className="font-medium text-zinc-900 hover:text-brand-600 dark:text-zinc-100 dark:hover:text-brand-400"
                >
                  {p.title}
                </Link>
                {!p.published && (
                  <Badge className="ml-2 bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                    Borrador
                  </Badge>
                )}
                {p.tags.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {p.tags.map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => onTag(tag)}
                        className="rounded-md bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"
                        title={`Filtrar por ${tag}`}
                      >
                        #{tag}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <DifficultyBadge difficulty={p.difficulty} />
            </li>
          ))}
        </ul>
      </Card>
      {error && (
        <p className="mt-2 text-sm text-red-600">No se pudo cargar la página. Intenta de nuevo.</p>
      )}
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
