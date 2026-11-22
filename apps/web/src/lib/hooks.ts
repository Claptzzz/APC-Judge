import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Paginación por token: guarda la pila de tokens visitados para poder volver atrás.
 * `reset` vuelve a la primera página (p. ej. al cambiar los filtros).
 */
export function usePageTokens() {
  const [stack, setStack] = useState<Array<string | null>>([null]);
  const pageToken = stack[stack.length - 1] ?? null;
  const next = useCallback((token: string) => setStack((s) => [...s, token]), []);
  const previous = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);
  const reset = useCallback(() => setStack([null]), []);
  return { pageToken, page: stack.length, hasPrevious: stack.length > 1, next, previous, reset };
}

/** Agrupa llamadas seguidas: ejecuta `fn` una vez, `delayMs` después de la última. */
export function useDebouncedCallback<A extends unknown[]>(
  fn: (...args: A) => void,
  delayMs: number,
) {
  const fnRef = useRef(fn);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return useCallback(
    (...args: A) => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => fnRef.current(...args), delayMs);
    },
    [delayMs],
  );
}

/** Fecha actual que se refresca cada `intervalMs` (para cuentas regresivas). */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
