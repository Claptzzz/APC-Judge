import { useMutation, useQuery } from '@apollo/client/react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import {
  Alert,
  Button,
  Card,
  DifficultyBadge,
  ErrorState,
  LoadingState,
  PageHeader,
  TextAreaField,
  TextField,
} from '../../components/ui';
import type { ProblemsQuery } from '../../gen/graphql';
import { CREATE_CONTEST, PROBLEMS } from '../../graphql/operations';
import { describeError } from '../../lib/errors';
import { localInputToIso } from '../../lib/format';

type ProblemOption = ProblemsQuery['problems']['items'][number];

export const MAX_CONTEST_PROBLEMS = 26;
const letterAt = (i: number) => String.fromCharCode(65 + i);

export interface ContestFormValues {
  title: string;
  description: string;
  start: string;
  end: string;
  problems: ProblemOption[];
}

export function validateContest(
  v: ContestFormValues,
): Partial<Record<'title' | 'start' | 'end' | 'problems', string>> {
  const errors: Partial<Record<'title' | 'start' | 'end' | 'problems', string>> = {};
  if (!v.title.trim()) errors.title = 'El título es obligatorio.';
  const start = localInputToIso(v.start);
  const end = localInputToIso(v.end);
  if (!start) errors.start = 'Indica la fecha de inicio.';
  if (!end) errors.end = 'Indica la fecha de término.';
  else if (start && Date.parse(end) <= Date.parse(start))
    errors.end = 'Debe ser posterior al inicio.';
  if (v.problems.length === 0) errors.problems = 'Agrega al menos un problema.';
  else if (v.problems.length > MAX_CONTEST_PROBLEMS) errors.problems = 'Máximo 26 problemas.';
  return errors;
}

export function CreateContestPage() {
  const navigate = useNavigate();
  const [values, setValues] = useState<ContestFormValues>({
    title: '',
    description: '',
    start: '',
    end: '',
    problems: [],
  });
  const [touched, setTouched] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [createContest, { loading }] = useMutation(CREATE_CONTEST);
  const catalog = useQuery(PROBLEMS, { variables: { pageSize: 100 } });

  const errors = validateContest(values);
  const shown = touched ? errors : {};
  const selected = new Set(values.problems.map((p) => p.id));
  const options = (catalog.data?.problems.items ?? []).filter(
    (p) => !selected.has(p.id) && p.title.toLowerCase().includes(search.trim().toLowerCase()),
  );

  const move = (i: number, delta: number) =>
    setValues((v) => {
      const list = [...v.problems];
      const j = i + delta;
      if (j < 0 || j >= list.length) return v;
      [list[i], list[j]] = [list[j]!, list[i]!];
      return { ...v, problems: list };
    });

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    setServerError(null);
    if (Object.keys(errors).length > 0) return;
    try {
      const { data } = await createContest({
        variables: {
          input: {
            title: values.title.trim(),
            description: values.description,
            startTime: localInputToIso(values.start)!,
            endTime: localInputToIso(values.end)!,
            problemIds: values.problems.map((p) => p.id),
          },
        },
      });
      if (data) navigate(`/contests/${data.createContest.id}`);
    } catch (err) {
      const d = describeError(err);
      setServerError(
        d.code === 'BAD_USER_INPUT' && d.detail ? `${d.message} (${d.detail})` : d.message,
      );
    }
  };

  return (
    <>
      <PageHeader
        title="Nuevo contest"
        subtitle="El orden de los problemas define las letras A, B, C…"
      />
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
        {serverError && <Alert>{serverError}</Alert>}
        <Card className="grid gap-4 p-5 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <TextField
              label="Título"
              value={values.title}
              onChange={(e) => setValues((v) => ({ ...v, title: e.target.value }))}
              error={shown.title}
            />
          </div>
          <TextField
            label="Inicio"
            type="datetime-local"
            value={values.start}
            onChange={(e) => setValues((v) => ({ ...v, start: e.target.value }))}
            error={shown.start}
            hint="Hora local de tu navegador"
          />
          <TextField
            label="Término"
            type="datetime-local"
            value={values.end}
            onChange={(e) => setValues((v) => ({ ...v, end: e.target.value }))}
            error={shown.end}
          />
          <div className="sm:col-span-2">
            <TextAreaField
              label="Descripción (Markdown, opcional)"
              rows={4}
              value={values.description}
              onChange={(e) => setValues((v) => ({ ...v, description: e.target.value }))}
              className="font-sans"
            />
          </div>
        </Card>

        <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-2">
          <Card className="p-5">
            <h2 className="mb-3 font-semibold">Problemas del contest ({values.problems.length})</h2>
            {shown.problems && (
              <p className="mb-2 text-sm text-red-600 dark:text-red-400">{shown.problems}</p>
            )}
            {values.problems.length === 0 ? (
              <p className="text-sm text-zinc-500">Agrega problemas desde el catálogo.</p>
            ) : (
              <ol className="flex flex-col gap-2" aria-label="Problemas seleccionados">
                {values.problems.map((p, i) => (
                  <li
                    key={p.id}
                    className="flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800"
                  >
                    <span className="w-5 font-mono font-semibold">{letterAt(i)}</span>
                    <span className="flex-1 truncate">{p.title}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Subir ${p.title}`}
                      onClick={() => move(i, -1)}
                      disabled={i === 0}
                    >
                      ↑
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Bajar ${p.title}`}
                      onClick={() => move(i, 1)}
                      disabled={i === values.problems.length - 1}
                    >
                      ↓
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Quitar ${p.title}`}
                      onClick={() =>
                        setValues((v) => ({
                          ...v,
                          problems: v.problems.filter((x) => x.id !== p.id),
                        }))
                      }
                    >
                      ✕
                    </Button>
                  </li>
                ))}
              </ol>
            )}
          </Card>

          <Card className="p-5">
            <h2 className="mb-3 font-semibold">Catálogo</h2>
            <TextField
              label="Buscar problema"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="mt-3 max-h-80 overflow-y-auto">
              {catalog.loading && !catalog.data ? (
                <LoadingState label="Cargando catálogo…" />
              ) : catalog.error && !catalog.data ? (
                <ErrorState error={catalog.error} onRetry={() => void catalog.refetch()} />
              ) : options.length === 0 ? (
                <p className="py-4 text-sm text-zinc-500">No hay más problemas para agregar.</p>
              ) : (
                <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
                  {options.map((p) => (
                    <li key={p.id} className="flex items-center gap-2 py-2 text-sm">
                      <span className="flex-1 truncate">{p.title}</span>
                      <DifficultyBadge difficulty={p.difficulty} />
                      <Button
                        variant="secondary"
                        size="sm"
                        aria-label={`Agregar ${p.title}`}
                        disabled={values.problems.length >= MAX_CONTEST_PROBLEMS}
                        onClick={() => setValues((v) => ({ ...v, problems: [...v.problems, p] }))}
                      >
                        Agregar
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
        </div>

        <div className="flex justify-end">
          <Button type="submit" loading={loading}>
            Crear contest
          </Button>
        </div>
      </form>
    </>
  );
}
