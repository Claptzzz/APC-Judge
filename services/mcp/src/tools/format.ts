import { timestampDate } from '@bufbuild/protobuf/wkt';
import type { Timestamp } from '@bufbuild/protobuf/wkt';
import { Difficulty, Language, Verdict } from '@juez/contracts/es';

/** Tope de caracteres para textos largos (enunciados, código fuente) devueltos al LLM. */
export const MAX_TEXT_CHARS = 4_000;

export interface Truncated {
  text: string;
  truncated: boolean;
  originalLength: number;
}

/** Recorta `text` a `max` caracteres; `truncated` indica si se cortó. */
export function truncate(text: string, max: number = MAX_TEXT_CHARS): Truncated {
  if (text.length <= max) return { text, truncated: false, originalLength: text.length };
  return { text: text.slice(0, max), truncated: true, originalLength: text.length };
}

/** Aviso que se agrega tras un texto recortado, para que el LLM no lo trate como completo. */
export function truncationNotice(t: Truncated, what: string): string {
  return t.truncated
    ? `\n[${what} truncado: se muestran ${t.text.length} de ${t.originalLength} caracteres]`
    : '';
}

export const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  [Difficulty.UNSPECIFIED]: 'sin dificultad',
  [Difficulty.EASY]: 'fácil',
  [Difficulty.MEDIUM]: 'media',
  [Difficulty.HARD]: 'difícil',
};

export const LANGUAGE_LABEL: Record<Language, string> = {
  [Language.UNSPECIFIED]: 'desconocido',
  [Language.CPP17]: 'C++17',
  [Language.PYTHON3]: 'Python 3',
};

/** Nombre corto (sigla de juez) y explicación de cada veredicto. */
export const VERDICT_INFO: Record<Verdict, { code: string; label: string; meaning: string }> = {
  [Verdict.UNSPECIFIED]: { code: '?', label: 'sin veredicto', meaning: 'Sin veredicto.' },
  [Verdict.PENDING]: {
    code: 'PENDING',
    label: 'pendiente',
    meaning: 'La submission está en cola, todavía no se evalúa.',
  },
  [Verdict.JUDGING]: {
    code: 'JUDGING',
    label: 'evaluando',
    meaning: 'La submission se está evaluando en este momento.',
  },
  [Verdict.ACCEPTED]: {
    code: 'AC',
    label: 'Accepted',
    meaning: 'Pasó todos los casos de prueba dentro de los límites.',
  },
  [Verdict.WRONG_ANSWER]: {
    code: 'WA',
    label: 'Wrong Answer',
    meaning:
      'El programa terminó bien pero su salida no coincide con la esperada en algún caso: ' +
      'suele ser un error de lógica, un caso borde no considerado, desborde de enteros o ' +
      'un formato de salida distinto.',
  },
  [Verdict.TIME_LIMIT_EXCEEDED]: {
    code: 'TLE',
    label: 'Time Limit Exceeded',
    meaning:
      'El programa superó el límite de tiempo en algún caso: normalmente el algoritmo es ' +
      'demasiado lento para el tamaño de la entrada (complejidad), hay un ciclo infinito o ' +
      'la lectura/escritura es ineficiente.',
  },
  [Verdict.MEMORY_LIMIT_EXCEEDED]: {
    code: 'MLE',
    label: 'Memory Limit Exceeded',
    meaning:
      'El programa usó más memoria que el límite: estructuras demasiado grandes, recursión ' +
      'muy profunda o datos que no se liberan.',
  },
  [Verdict.RUNTIME_ERROR]: {
    code: 'RE',
    label: 'Runtime Error',
    meaning:
      'El programa terminó con error en algún caso: acceso fuera de rango, división por ' +
      'cero, excepción no capturada, desborde de pila o código de salida distinto de 0.',
  },
  [Verdict.COMPILATION_ERROR]: {
    code: 'CE',
    label: 'Compilation Error',
    meaning: 'El código no compiló; no se ejecutó ningún caso.',
  },
  [Verdict.INTERNAL_ERROR]: {
    code: 'IE',
    label: 'Internal Error',
    meaning: 'Falla interna del juez, no del código del usuario. Conviene reenviar más tarde.',
  },
};

export function verdictInfo(verdict: Verdict) {
  return VERDICT_INFO[verdict] ?? VERDICT_INFO[Verdict.UNSPECIFIED];
}

/** Timestamp protobuf → ISO 8601 (o undefined si viene vacío). */
export function isoDate(ts: Timestamp | undefined): string | undefined {
  return ts ? timestampDate(ts).toISOString() : undefined;
}

/** Fecha compacta legible: `2026-11-20 14:05 UTC`. */
export function shortDate(ts: Timestamp | undefined): string {
  const iso = isoDate(ts);
  return iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : 'sin fecha';
}

/** Memoria en KB → texto (`512 KB` / `12.5 MB`). */
export function formatMemory(kb: number): string {
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;
}

/** Línea de paginación para que el LLM sepa cómo pedir más. */
export function nextPageHint(nextPageToken: string): string {
  return nextPageToken
    ? `\nHay más resultados: vuelve a llamar con page_token="${nextPageToken}".`
    : '';
}
