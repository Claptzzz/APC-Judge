export const SLUG_MAX_LENGTH = 80;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidSlug(slug: string): boolean {
  return slug.length <= SLUG_MAX_LENGTH && SLUG_PATTERN.test(slug);
}

/**
 * Genera un slug desde el título: sin tildes, minúsculas, solo [a-z0-9] separados por guiones.
 * "Suma de Dos Números" → "suma-de-dos-numeros". Si no queda nada, devuelve "problema".
 */
export function slugify(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\+/g, ' mas ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH - 4) // deja espacio para un sufijo "-NNN"
    .replace(/-+$/g, '');
  return slug || 'problema';
}

/** Candidatos para resolver colisiones: base, base-2, base-3, … */
export function slugCandidate(base: string, attempt: number): string {
  return attempt <= 1 ? base : `${base}-${attempt}`;
}
