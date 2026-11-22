import type { ContestStatus, Difficulty, Language, Role, Verdict } from '../gen/graphql';

export const VERDICT_LABELS: Record<Verdict, string> = {
  PENDING: 'En cola',
  JUDGING: 'Evaluando',
  ACCEPTED: 'Aceptado',
  WRONG_ANSWER: 'Respuesta incorrecta',
  TIME_LIMIT_EXCEEDED: 'Tiempo límite excedido',
  MEMORY_LIMIT_EXCEEDED: 'Memoria límite excedida',
  RUNTIME_ERROR: 'Error en ejecución',
  COMPILATION_ERROR: 'Error de compilación',
  INTERNAL_ERROR: 'Error interno del juez',
};

export const VERDICT_SHORT: Record<Verdict, string> = {
  PENDING: 'PEND',
  JUDGING: 'JUDG',
  ACCEPTED: 'AC',
  WRONG_ANSWER: 'WA',
  TIME_LIMIT_EXCEEDED: 'TLE',
  MEMORY_LIMIT_EXCEEDED: 'MLE',
  RUNTIME_ERROR: 'RE',
  COMPILATION_ERROR: 'CE',
  INTERNAL_ERROR: 'IE',
};

export function isFinalVerdict(verdict: Verdict): boolean {
  return verdict !== 'PENDING' && verdict !== 'JUDGING';
}

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  EASY: 'Fácil',
  MEDIUM: 'Media',
  HARD: 'Difícil',
};

export const LANGUAGE_LABELS: Record<Language, string> = {
  CPP17: 'C++17',
  PYTHON3: 'Python 3',
};

export const LANGUAGES: Language[] = ['CPP17', 'PYTHON3'];

export const CONTEST_STATUS_LABELS: Record<ContestStatus, string> = {
  UPCOMING: 'Próximo',
  RUNNING: 'En curso',
  FINISHED: 'Finalizado',
};

export const ROLE_LABELS: Record<Role, string> = {
  CONTESTANT: 'Participante',
  SETTER: 'Autor',
  ADMIN: 'Administrador',
};

const dateTimeFormat = new Intl.DateTimeFormat('es-CL', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : dateTimeFormat.format(date);
}

export function formatMemory(kb: number | null | undefined): string {
  if (kb === null || kb === undefined) return '—';
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;
}

export function formatMs(ms: number | null | undefined): string {
  return ms === null || ms === undefined ? '—' : `${ms} ms`;
}

/** Duración legible ("2 h 05 min", "45 min", "30 s"). */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${String(minutes).padStart(2, '0')} min`;
  if (minutes > 0) return `${minutes} min`;
  return `${seconds} s`;
}

/** `datetime-local` (hora local del navegador) → ISO 8601 en UTC. */
export function localInputToIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
