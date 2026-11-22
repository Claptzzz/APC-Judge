import { useApolloClient, useMutation, useQuery } from '@apollo/client/react';
import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { Markdown } from '../../components/Markdown';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  SelectField,
  TextAreaField,
  TextField,
  cx,
} from '../../components/ui';
import type { Difficulty, ProblemFieldsFragment } from '../../gen/graphql';
import {
  CREATE_PROBLEM,
  CREATE_TESTCASE_UPLOAD,
  PROBLEM,
  UPDATE_PROBLEM,
} from '../../graphql/operations';
import { useAuth } from '../../lib/auth';
import { describeError } from '../../lib/errors';
import { DIFFICULTY_LABELS } from '../../lib/format';
import { pairTestcaseFiles, uploadToPresignedUrl, type TestcasePair } from '../../lib/testcases';

interface ExampleValue {
  input: string;
  output: string;
  explanation: string;
}

export interface ProblemFormValues {
  title: string;
  slug: string;
  statement: string;
  difficulty: Difficulty;
  tags: string;
  timeLimitMs: string;
  memoryLimitMb: string;
  examples: ExampleValue[];
  published: boolean;
}

const EMPTY: ProblemFormValues = {
  title: '',
  slug: '',
  statement: '',
  difficulty: 'EASY',
  tags: '',
  timeLimitMs: '1000',
  memoryLimitMb: '256',
  examples: [],
  published: false,
};

function fromProblem(p: ProblemFieldsFragment): ProblemFormValues {
  return {
    title: p.title,
    slug: p.slug,
    statement: p.statement,
    difficulty: p.difficulty,
    tags: p.tags.join(', '),
    timeLimitMs: String(p.timeLimitMs),
    memoryLimitMb: String(p.memoryLimitMb),
    examples: p.examples.map((e) => ({
      input: e.input,
      output: e.output,
      explanation: e.explanation ?? '',
    })),
    published: p.published,
  };
}

export function parseTagList(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

type FormErrors = Partial<
  Record<
    'title' | 'slug' | 'statement' | 'tags' | 'timeLimitMs' | 'memoryLimitMb' | 'examples',
    string
  >
>;

export function validateProblem(v: ProblemFormValues): FormErrors {
  const errors: FormErrors = {};
  if (!v.title.trim()) errors.title = 'El título es obligatorio.';
  else if (v.title.length > 200) errors.title = 'Máximo 200 caracteres.';
  if (v.slug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v.slug))
    errors.slug = 'Solo minúsculas, números y guiones.';
  if (!v.statement.trim()) errors.statement = 'El enunciado es obligatorio.';
  else if (v.statement.length > 100_000) errors.statement = 'Máximo 100.000 caracteres.';
  const tags = parseTagList(v.tags);
  if (tags.length > 20) errors.tags = 'Máximo 20 tags.';
  else if (tags.some((t) => t.length > 40))
    errors.tags = 'Cada tag puede tener hasta 40 caracteres.';
  const time = Number(v.timeLimitMs);
  if (!Number.isInteger(time) || time < 100 || time > 20_000)
    errors.timeLimitMs = 'Entre 100 y 20.000 ms.';
  const memory = Number(v.memoryLimitMb);
  if (!Number.isInteger(memory) || memory < 16 || memory > 2048)
    errors.memoryLimitMb = 'Entre 16 y 2048 MB.';
  if (v.examples.length > 20) errors.examples = 'Máximo 20 ejemplos.';
  else if (v.examples.some((e) => !e.input.trim() || !e.output.trim()))
    errors.examples = 'Cada ejemplo necesita entrada y salida.';
  return errors;
}

function toCommonInput(v: ProblemFormValues) {
  return {
    title: v.title.trim(),
    statement: v.statement,
    difficulty: v.difficulty,
    tags: parseTagList(v.tags),
    timeLimitMs: Number(v.timeLimitMs),
    memoryLimitMb: Number(v.memoryLimitMb),
    examples: v.examples.map((e) => ({
      input: e.input,
      output: e.output,
      explanation: e.explanation.trim() ? e.explanation : null,
    })),
  };
}

function ProblemForm({
  initial,
  mode,
  submitting,
  serverError,
  onSubmit,
}: {
  initial: ProblemFormValues;
  mode: 'create' | 'edit';
  submitting: boolean;
  serverError: string | null;
  onSubmit: (values: ProblemFormValues) => void;
}) {
  const [values, setValues] = useState(initial);
  const [touched, setTouched] = useState(false);
  const [preview, setPreview] = useState(false);
  const errors = validateProblem(values);
  const shown = touched ? errors : {};
  const set = <K extends keyof ProblemFormValues>(key: K, value: ProblemFormValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }));
  const setExample = (i: number, patch: Partial<ExampleValue>) =>
    set(
      'examples',
      values.examples.map((e, j) => (j === i ? { ...e, ...patch } : e)),
    );

  const handle = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(errors).length === 0) onSubmit(values);
  };

  return (
    <form onSubmit={handle} noValidate className="flex flex-col gap-5">
      {serverError && <Alert>{serverError}</Alert>}
      <Card className="grid gap-4 p-5 sm:grid-cols-2">
        <TextField
          label="Título"
          value={values.title}
          onChange={(e) => set('title', e.target.value)}
          error={shown.title}
        />
        {mode === 'create' ? (
          <TextField
            label="Slug (opcional)"
            value={values.slug}
            onChange={(e) => set('slug', e.target.value)}
            error={shown.slug}
            hint="Si lo dejas vacío se genera desde el título."
          />
        ) : (
          <TextField
            label="Slug"
            value={values.slug}
            disabled
            hint="El slug no se puede cambiar."
          />
        )}
        <SelectField
          label="Dificultad"
          value={values.difficulty}
          onChange={(e) => set('difficulty', e.target.value as Difficulty)}
        >
          {(Object.keys(DIFFICULTY_LABELS) as Difficulty[]).map((d) => (
            <option key={d} value={d}>
              {DIFFICULTY_LABELS[d]}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Tags"
          value={values.tags}
          onChange={(e) => set('tags', e.target.value)}
          error={shown.tags}
          hint="Separados por comas, p. ej. grafos, bfs"
        />
        <TextField
          label="Tiempo límite (ms)"
          type="number"
          inputMode="numeric"
          value={values.timeLimitMs}
          onChange={(e) => set('timeLimitMs', e.target.value)}
          error={shown.timeLimitMs}
        />
        <TextField
          label="Memoria límite (MB)"
          type="number"
          inputMode="numeric"
          value={values.memoryLimitMb}
          onChange={(e) => set('memoryLimitMb', e.target.value)}
          error={shown.memoryLimitMb}
        />
        {mode === 'edit' && (
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              checked={values.published}
              onChange={(e) => set('published', e.target.checked)}
              className="size-4 accent-brand-600"
            />
            Publicado (visible para todos los participantes)
          </label>
        )}
      </Card>

      <Card className="p-5">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            Admite Markdown (sin HTML)
          </span>
          <div className="flex gap-1 text-sm">
            <button
              type="button"
              className={cx('rounded px-2 py-1', !preview && 'bg-zinc-100 dark:bg-zinc-800')}
              onClick={() => setPreview(false)}
            >
              Editar
            </button>
            <button
              type="button"
              className={cx('rounded px-2 py-1', preview && 'bg-zinc-100 dark:bg-zinc-800')}
              onClick={() => setPreview(true)}
            >
              Vista previa
            </button>
          </div>
        </div>
        {preview ? (
          <div className="min-h-48 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
            {values.statement.trim() ? (
              <Markdown>{values.statement}</Markdown>
            ) : (
              <p className="text-sm text-zinc-500">Nada que mostrar.</p>
            )}
          </div>
        ) : (
          <TextAreaField
            label="Enunciado"
            rows={14}
            value={values.statement}
            onChange={(e) => set('statement', e.target.value)}
            error={shown.statement}
          />
        )}
      </Card>

      <Card className="flex flex-col gap-4 p-5">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Ejemplos</h2>
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              set('examples', [...values.examples, { input: '', output: '', explanation: '' }])
            }
            disabled={values.examples.length >= 20}
          >
            Agregar ejemplo
          </Button>
        </div>
        {shown.examples && (
          <p className="text-sm text-red-600 dark:text-red-400">{shown.examples}</p>
        )}
        {values.examples.length === 0 && <p className="text-sm text-zinc-500">Sin ejemplos.</p>}
        {values.examples.map((ex, i) => (
          <fieldset
            key={i}
            className="grid gap-3 rounded-lg border border-zinc-200 p-3 sm:grid-cols-2 dark:border-zinc-800"
          >
            <legend className="px-1 text-sm font-medium">Ejemplo {i + 1}</legend>
            <TextAreaField
              label="Entrada"
              rows={3}
              value={ex.input}
              onChange={(e) => setExample(i, { input: e.target.value })}
            />
            <TextAreaField
              label="Salida"
              rows={3}
              value={ex.output}
              onChange={(e) => setExample(i, { output: e.target.value })}
            />
            <div className="sm:col-span-2">
              <TextAreaField
                label="Explicación (opcional)"
                rows={2}
                value={ex.explanation}
                onChange={(e) => setExample(i, { explanation: e.target.value })}
              />
            </div>
            <div className="sm:col-span-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  set(
                    'examples',
                    values.examples.filter((_, j) => j !== i),
                  )
                }
              >
                Quitar ejemplo
              </Button>
            </div>
          </fieldset>
        ))}
      </Card>

      <div className="flex justify-end gap-2">
        <Button type="submit" loading={submitting}>
          {mode === 'create' ? 'Crear problema' : 'Guardar cambios'}
        </Button>
      </div>
    </form>
  );
}

export function CreateProblemPage() {
  const navigate = useNavigate();
  const [createProblem, { loading }] = useMutation(CREATE_PROBLEM);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (values: ProblemFormValues) => {
    setError(null);
    try {
      const { data } = await createProblem({
        variables: {
          input: { ...toCommonInput(values), ...(values.slug ? { slug: values.slug } : {}) },
        },
      });
      if (data)
        navigate(`/admin/problems/${data.createProblem.slug}/edit`, {
          state: { created: true },
        });
    } catch (err) {
      const d = describeError(err, { CONFLICT: 'Ya existe un problema con ese slug.' });
      setError(d.code === 'BAD_USER_INPUT' && d.detail ? `${d.message} (${d.detail})` : d.message);
    }
  };

  return (
    <>
      <PageHeader
        title="Nuevo problema"
        subtitle="Se crea sin publicar. Después podrás subir los casos de prueba."
      />
      <ProblemForm
        initial={EMPTY}
        mode="create"
        submitting={loading}
        serverError={error}
        onSubmit={onSubmit}
      />
    </>
  );
}

export function EditProblemPage() {
  const { slug = '' } = useParams();
  const location = useLocation();
  const created = (location.state as { created?: boolean } | null)?.created ?? false;
  const { user, hasRole } = useAuth();
  const { data, loading, error, refetch } = useQuery(PROBLEM, {
    variables: { slug },
    fetchPolicy: 'network-only',
  });
  const [updateProblem, { loading: saving }] = useMutation(UPDATE_PROBLEM);
  const [serverError, setServerError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (loading && !data) return <LoadingState label="Cargando problema…" />;
  if (error && !data) return <ErrorState error={error} onRetry={() => void refetch()} />;
  const problem = data?.problem;
  if (!problem) return <EmptyState title="Problema no encontrado" />;
  if (!hasRole('ADMIN') && problem.authorId !== user?.id)
    return <EmptyState title="Solo el autor o un administrador puede editar este problema" />;

  const onSubmit = async (values: ProblemFormValues) => {
    setServerError(null);
    setSaved(false);
    try {
      await updateProblem({
        variables: {
          id: problem.id,
          input: { ...toCommonInput(values), published: values.published },
        },
      });
      setSaved(true);
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
        title={`Editar: ${problem.title}`}
        subtitle={`${problem.testcaseCount} casos de prueba · ${problem.published ? 'Publicado' : 'Sin publicar'}`}
        actions={
          <Link className="link text-sm" to={`/problems/${problem.slug}`}>
            Ver enunciado
          </Link>
        }
      />
      <div className="flex flex-col gap-6">
        {created && (
          <Alert tone="success">
            Problema creado. Sube los casos de prueba y publícalo cuando esté listo.
          </Alert>
        )}
        {saved && <Alert tone="success">Cambios guardados.</Alert>}
        <TestcaseUploader problemId={problem.id} nextOrdinal={problem.testcaseCount + 1} />
        <ProblemForm
          key={problem.updatedAt}
          initial={fromProblem(problem)}
          mode="edit"
          submitting={saving}
          serverError={serverError}
          onSubmit={onSubmit}
        />
      </div>
    </>
  );
}

type UploadStatus = 'pending' | 'uploading' | 'done' | 'error';

interface UploadRow {
  pair: TestcasePair;
  ordinal: number;
  status: UploadStatus;
  error?: string;
}

export function TestcaseUploader({
  problemId,
  nextOrdinal,
}: {
  problemId: string;
  nextOrdinal: number;
}) {
  const client = useApolloClient();
  const [createUpload] = useMutation(CREATE_TESTCASE_UPLOAD);
  const [startOrdinal, setStartOrdinal] = useState(String(nextOrdinal));
  const [rows, setRows] = useState<UploadRow[]>([]);
  const [unmatched, setUnmatched] = useState<string[]>([]);
  const [running, setRunning] = useState(false);

  const onFiles = (list: FileList | null) => {
    const { pairs, unmatched: rest } = pairTestcaseFiles(Array.from(list ?? []));
    const start = Number(startOrdinal) || nextOrdinal;
    setRows(pairs.map((pair, i) => ({ pair, ordinal: start + i, status: 'pending' })));
    setUnmatched(rest);
  };

  const patch = (i: number, p: Partial<UploadRow>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));

  const uploadAll = async () => {
    setRunning(true);
    for (const [i, row] of rows.entries()) {
      if (row.status === 'done') continue;
      patch(i, { status: 'uploading', error: undefined });
      try {
        const { data } = await createUpload({ variables: { problemId, ordinal: row.ordinal } });
        if (!data) throw new Error('Sin respuesta');
        const urls = data.createTestcaseUploadUrl;
        await uploadToPresignedUrl(urls.inputUploadUrl, row.pair.input);
        await uploadToPresignedUrl(urls.outputUploadUrl, row.pair.output);
        patch(i, { status: 'done' });
      } catch (err) {
        const message =
          err instanceof Error && /HTTP/.test(err.message)
            ? err.message
            : describeError(err).message;
        patch(i, { status: 'error', error: message });
      }
    }
    setRunning(false);
    // testcaseCount cambió: se refresca el problema (si falla, queda el conteo anterior).
    try {
      await client.refetchQueries({ include: ['Problem'] });
    } catch {
      // El estado de cada caso ya se muestra en la lista.
    }
  };

  const done = rows.filter((r) => r.status === 'done').length;

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div>
        <h2 className="font-semibold">Casos de prueba</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Selecciona pares de archivos <code>1.in</code> / <code>1.out</code> (también{' '}
          <code>.ans</code>). Se suben directo al almacenamiento; un ordinal existente se reemplaza.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-[160px_1fr]">
        <TextField
          label="Primer ordinal"
          type="number"
          min={1}
          max={1000}
          value={startOrdinal}
          onChange={(e) => setStartOrdinal(e.target.value)}
          disabled={running}
        />
        <div className="flex flex-col gap-1.5">
          <label htmlFor="testcase-files" className="text-sm font-medium">
            Archivos
          </label>
          <input
            id="testcase-files"
            type="file"
            multiple
            disabled={running}
            onChange={(e) => onFiles(e.target.files)}
            className="text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-100 file:px-3 file:py-2 file:text-sm file:font-medium dark:file:bg-zinc-800 dark:file:text-zinc-100"
          />
        </div>
      </div>
      {unmatched.length > 0 && (
        <Alert tone="warning" title="Archivos sin pareja (se ignoran)">
          {unmatched.join(', ')}
        </Alert>
      )}
      {rows.length > 0 && (
        <>
          <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 text-sm dark:divide-zinc-800 dark:border-zinc-800">
            {rows.map((r) => (
              <li key={r.pair.name} className="flex items-center gap-3 px-3 py-2">
                <span className="w-12 font-mono text-zinc-500">#{r.ordinal}</span>
                <span className="flex-1 truncate">
                  {r.pair.input.name} + {r.pair.output.name}
                </span>
                <span
                  className={cx(
                    'text-xs',
                    r.status === 'done' && 'text-emerald-600',
                    r.status === 'error' && 'text-red-600',
                    r.status === 'uploading' && 'text-sky-600',
                  )}
                >
                  {
                    {
                      pending: 'Pendiente',
                      uploading: 'Subiendo…',
                      done: 'Subido',
                      error: r.error ?? 'Error',
                    }[r.status]
                  }
                </span>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm text-zinc-500">
              {done} de {rows.length} subidos
            </span>
            <Button
              onClick={() => void uploadAll()}
              loading={running}
              disabled={done === rows.length}
            >
              Subir {rows.length - done} caso(s)
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
