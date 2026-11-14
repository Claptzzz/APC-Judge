import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

/** Herramientas de aislamiento disponibles en esta máquina/contenedor. */
export interface SandboxCapabilities {
  /** Ruta de `prlimit` (util-linux). Obligatorio. */
  prlimit: string;
  /** Ruta de `unshare` si `unshare -rn` funciona (sin red); `null` si no se puede aislar la red. */
  unshare: string | null;
  /** Ruta de GNU `time` si está disponible (mide la memoria máxima, RSS); `null` si no. */
  time: string | null;
}

export const DEFAULT_PATH = '/usr/local/bin:/usr/bin:/bin';

export async function findExecutable(
  name: string,
  path = process.env.PATH ?? DEFAULT_PATH,
): Promise<string | null> {
  if (name.includes('/')) {
    return (await isExecutable(name)) ? name : null;
  }
  for (const dir of path.split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Ejecuta un comando de prueba y devuelve si terminó con código 0. */
export function probe(command: string, args: string[], timeoutMs = 5_000): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs }, (error) => resolve(!error));
  });
}

export interface DetectOptions {
  path?: string;
  /** Ruta de GNU time a probar (por defecto `/usr/bin/time`, no el builtin del shell). */
  timePath?: string;
}

/**
 * Detecta las herramientas del sandbox. Lanza un error si falta `prlimit` (sin él no hay
 * límites de memoria). `unshare -rn` puede fallar en contenedores sin user namespaces.
 */
export async function detectSandbox(options: DetectOptions = {}): Promise<SandboxCapabilities> {
  const prlimit = await findExecutable('prlimit', options.path);
  if (!prlimit)
    throw new Error('No se encontró prlimit (util-linux): el sandbox no puede limitar memoria');

  const unshareBin = await findExecutable('unshare', options.path);
  const unshare =
    unshareBin && (await probe(unshareBin, ['-rn', '--', 'true'])) ? unshareBin : null;

  const timeBin = await findExecutable(options.timePath ?? '/usr/bin/time', options.path);
  const time =
    timeBin && (await probe(timeBin, ['-f', '%M', '-o', '/dev/null', 'true'])) ? timeBin : null;

  return { prlimit, unshare, time };
}
