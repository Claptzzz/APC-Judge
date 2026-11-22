import { useMutation } from '@apollo/client/react';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Markdown } from '../components/Markdown';
import { Alert, Button, Card, PageHeader, Spinner, cx } from '../components/ui';
import type { AskAssistantMutation } from '../gen/graphql';
import { ASK_ASSISTANT } from '../graphql/operations';
import { useAuth } from '../lib/auth';
import { describeError, type DescribedError } from '../lib/errors';
import { useNow } from '../lib/hooks';

export interface ChatMessage {
  id: string;
  role: 'USER' | 'ASSISTANT';
  content: string;
  toolCalls?: AskAssistantMutation['askAssistant']['toolCalls'];
  /** Mensajes del usuario que no obtuvieron respuesta (no se envían en el historial). */
  failed?: boolean;
}

const MAX_HISTORY = 20;
const SUGGESTIONS = [
  '¿Qué problemas fáciles de grafos hay?',
  '¿Cómo voy en el contest que está en curso?',
  '¿Por qué pudo fallar mi último envío?',
];

const storageKey = (userId: string) => `juez.assistant.${userId}`;

function loadHistory(userId: string): ChatMessage[] {
  try {
    const raw = sessionStorage.getItem(storageKey(userId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as ChatMessage[]) : [];
  } catch {
    return [];
  }
}

function saveHistory(userId: string, messages: ChatMessage[]) {
  try {
    sessionStorage.setItem(storageKey(userId), JSON.stringify(messages.slice(-50)));
  } catch {
    // Sin sessionStorage el historial dura lo que la pestaña.
  }
}

type TimedError = DescribedError & { at: number };

function timedError(err: unknown): TimedError {
  return { ...describeError(err), at: Date.now() };
}

let counter = 0;
const newId = () => `${Date.now().toString(36)}-${(counter++).toString(36)}`;

/** Historial que se envía: solo intercambios completos, del más antiguo al más reciente. */
export function buildHistory(messages: ChatMessage[]) {
  return messages
    .filter((m) => !m.failed)
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content }));
}

function ToolChips({ calls }: { calls: NonNullable<ChatMessage['toolCalls']> }) {
  if (calls.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Herramientas usadas">
      {calls.map((call, i) => (
        <li
          key={`${call.name}-${i}`}
          title={`Argumentos: ${call.arguments}`}
          className={cx(
            'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px]',
            call.isError
              ? 'border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300'
              : 'border-zinc-300 bg-zinc-50 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
          )}
        >
          <span aria-hidden>{call.isError ? '⚠' : '🔧'}</span>
          {call.name}
          {call.isError && <span className="sr-only"> (falló)</span>}
        </li>
      ))}
    </ul>
  );
}

function errorTitle(error: DescribedError): string {
  if (error.code === 'ASSISTANT_DISABLED') return 'Asistente deshabilitado';
  if (error.code === 'RATE_LIMITED') return 'Demasiadas preguntas seguidas';
  return 'No pudimos obtener una respuesta';
}

export function AssistantPage() {
  const { user } = useAuth();
  const userId = user?.id ?? 'anon';
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadHistory(userId));
  const [input, setInput] = useState('');
  const [error, setError] = useState<TimedError | null>(null);
  const [ask, { loading }] = useMutation(ASK_ASSISTANT);
  const bottom = useRef<HTMLDivElement>(null);
  const now = useNow(1000);

  // `now` avanza cada segundo; justo después del error puede ser anterior a `error.at`.
  const reference = error ? Math.max(now, error.at) : now;
  const retryAt = error?.retryAfterSeconds ? error.at + error.retryAfterSeconds * 1000 : null;
  const waitSeconds = retryAt && retryAt > reference ? Math.ceil((retryAt - reference) / 1000) : 0;

  useEffect(() => saveHistory(userId, messages), [userId, messages]);
  useEffect(() => {
    bottom.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' });
  }, [messages, loading]);

  const send = async (text: string, base: ChatMessage[]) => {
    const content = text.trim();
    if (!content || loading) return;
    const userMessage: ChatMessage = { id: newId(), role: 'USER', content };
    setMessages([...base, userMessage]);
    setError(null);
    try {
      const { data } = await ask({ variables: { message: content, history: buildHistory(base) } });
      if (!data) return;
      const answer = data.askAssistant;
      setMessages([
        ...base,
        userMessage,
        { id: newId(), role: 'ASSISTANT', content: answer.message, toolCalls: answer.toolCalls },
      ]);
    } catch (err) {
      setMessages([...base, { ...userMessage, failed: true }]);
      setError(timedError(err));
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const text = input;
    setInput('');
    void send(text, messages);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSubmit(e);
    }
  };

  const retry = () => {
    const last = messages[messages.length - 1];
    if (last?.failed) void send(last.content, messages.slice(0, -1));
  };

  const reset = () => {
    setMessages([]);
    setError(null);
  };

  return (
    <div className="mx-auto flex h-[calc(100dvh-10rem)] max-w-3xl flex-col">
      <PageHeader
        title="Asistente"
        subtitle="Pregunta por problemas, tus envíos o el scoreboard. Solo ve lo que tú puedes ver."
        actions={
          messages.length > 0 && (
            <Button variant="secondary" size="sm" onClick={reset} disabled={loading}>
              Nueva conversación
            </Button>
          )
        }
      />
      <Card className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto p-4" aria-live="polite">
          {messages.length === 0 && !loading ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <p className="text-zinc-600 dark:text-zinc-400">¿En qué te ayudo?</p>
              <div className="flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="rounded-full border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                    onClick={() => void send(s, messages)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <ol className="flex flex-col gap-4">
              {messages.map((m) => (
                <li
                  key={m.id}
                  className={cx('flex', m.role === 'USER' ? 'justify-end' : 'justify-start')}
                >
                  <div
                    className={cx(
                      'max-w-[85%] rounded-2xl px-4 py-2.5 text-sm',
                      m.role === 'USER'
                        ? 'bg-brand-600 text-white'
                        : 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100',
                      m.failed && 'opacity-60',
                    )}
                  >
                    <span className="sr-only">{m.role === 'USER' ? 'Tú:' : 'Asistente:'}</span>
                    {m.role === 'ASSISTANT' ? (
                      <Markdown className="prose-juez prose-chat">{m.content}</Markdown>
                    ) : (
                      <p className="whitespace-pre-wrap">{m.content}</p>
                    )}
                    {m.toolCalls && <ToolChips calls={m.toolCalls} />}
                    {m.failed && <p className="mt-1 text-xs">Sin respuesta</p>}
                  </div>
                </li>
              ))}
              {loading && (
                <li className="flex items-center gap-2 text-sm text-zinc-500" role="status">
                  <Spinner className="size-4" /> El asistente está pensando…
                </li>
              )}
            </ol>
          )}
          <div ref={bottom} />
        </div>
        {error && (
          <div className="border-t border-zinc-200 p-3 dark:border-zinc-800">
            <Alert
              tone={
                error.code === 'ASSISTANT_DISABLED' || error.code === 'RATE_LIMITED'
                  ? 'warning'
                  : 'error'
              }
              title={errorTitle(error)}
              action={
                error.code !== 'ASSISTANT_DISABLED' && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={retry}
                    disabled={waitSeconds > 0 || loading}
                  >
                    {waitSeconds > 0 ? `Reintentar en ${waitSeconds} s` : 'Reintentar'}
                  </Button>
                )
              }
            >
              <p>{error.message}</p>
            </Alert>
          </div>
        )}
        <form
          onSubmit={onSubmit}
          className="flex items-end gap-2 border-t border-zinc-200 p-3 dark:border-zinc-800"
        >
          <label htmlFor="assistant-input" className="sr-only">
            Mensaje para el asistente
          </label>
          <textarea
            id="assistant-input"
            rows={2}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Escribe tu pregunta… (Enter envía, Shift+Enter salto de línea)"
            className="min-h-[2.75rem] flex-1 resize-none rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            maxLength={4000}
          />
          <Button type="submit" loading={loading} disabled={!input.trim() || waitSeconds > 0}>
            Enviar
          </Button>
        </form>
      </Card>
    </div>
  );
}
