import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { open, readFile, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { SandboxCapabilities } from './capabilities.js';
import { DEFAULT_PATH } from './capabilities.js';

export interface RunOptions {
  command: string;
  args: string[];
  cwd: string;
  sandbox: SandboxCapabilities;
  /** Tiempo de pared máximo; al excederlo se mata el grupo de procesos. */
  wallTimeLimitMs: number;
  /** Límite del espacio de direcciones (`prlimit --as`), en MB. */
  memoryLimitMb?: number;
  /** Límite de CPU (`prlimit --cpu`), en segundos. Respaldo del límite de pared. */
  cpuTimeLimitS?: number;
  /** Tamaño máximo de archivo que puede escribir el proceso (`prlimit --fsize`). */
  fileSizeLimitBytes?: number;
  /** Archivo que se conecta a stdin. Sin él, stdin es /dev/null. */
  stdinPath?: string;
  /** Salida máxima por stdout; al excederla se mata el proceso. */
  maxStdoutBytes: number;
  /** stderr se trunca (sin matar el proceso). */
  maxStderrBytes?: number;
  /** Archivo donde GNU time escribe la memoria máxima (requerido si `sandbox.time`). */
  timeOutputPath?: string;
  env?: Record<string, string>;
}

export interface RunResult {
  /** Código de salida del programa (no del envoltorio), o null si murió por señal. */
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  wallTimeMs: number;
  /** RSS máximo en KB (GNU time) o null si no se pudo medir. */
  memoryKb: number | null;
  stdout: Buffer;
  stderr: Buffer;
  /** Error al lanzar el proceso (p. ej. ENOENT). */
  spawnError?: Error;
}

/** Arma la línea de comandos: unshare -rn → time → prlimit → programa. */
export function buildCommand(options: RunOptions): string[] {
  const { sandbox } = options;
  let argv = [options.command, ...options.args];

  const limits: string[] = ['--core=0'];
  if (options.memoryLimitMb !== undefined)
    limits.push(`--as=${options.memoryLimitMb * 1024 * 1024}`);
  if (options.cpuTimeLimitS !== undefined) limits.push(`--cpu=${options.cpuTimeLimitS}`);
  if (options.fileSizeLimitBytes !== undefined)
    limits.push(`--fsize=${options.fileSizeLimitBytes}`);
  argv = [sandbox.prlimit, ...limits, '--', ...argv];

  if (sandbox.time && options.timeOutputPath) {
    argv = [sandbox.time, '-f', '%M', '-o', options.timeOutputPath, ...argv];
  }
  if (sandbox.unshare) {
    argv = [sandbox.unshare, '-rn', '--', ...argv];
  }
  return argv;
}

export interface TimeReport {
  memoryKb: number | null;
  exitCode: number | null;
  signal: string | null;
}

function signalName(num: number): string {
  const entry = Object.entries(osConstants.signals).find(([, value]) => value === num);
  return entry ? entry[0] : `SIG${num}`;
}

/**
 * Interpreta el archivo de GNU time (`-f %M -o file`). Antes del valor de %M, GNU time
 * escribe "Command terminated by signal N" o "Command exited with non-zero status N".
 */
export function parseTimeReport(content: string): TimeReport {
  const report: TimeReport = { memoryKb: null, exitCode: 0, signal: null };
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    let match: RegExpExecArray | null;
    if ((match = /^Command terminated by signal (\d+)/.exec(line))) {
      report.signal = signalName(Number(match[1]));
      report.exitCode = null;
    } else if ((match = /^Command exited with non-zero status (\d+)/.exec(line))) {
      report.exitCode = Number(match[1]);
    } else if (/^\d+$/.test(line)) {
      report.memoryKb = Number(line);
    }
  }
  return report;
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // El grupo ya no existe.
  }
}

/**
 * Ejecuta un proceso con límites. El proceso queda en su propio grupo (`detached`), así al
 * vencer el tiempo o exceder la salida se mata el grupo completo.
 */
export async function runProcess(options: RunOptions): Promise<RunResult> {
  const argv = buildCommand(options);
  const maxStderr = options.maxStderrBytes ?? 64 * 1024;
  const useTime = Boolean(options.sandbox.time && options.timeOutputPath);
  if (useTime) await rm(options.timeOutputPath!, { force: true });

  let stdin: FileHandle | undefined;
  if (options.stdinPath) stdin = await open(options.stdinPath, 'r');

  const result = await new Promise<RunResult>((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let exitInfo: { code: number | null; signal: string | null; at: number } | undefined;
    let settled = false;

    const start = performance.now();
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd,
      env: options.env ?? { PATH: DEFAULT_PATH, LANG: 'C.UTF-8', HOME: options.cwd },
      detached: true,
      stdio: [stdin ? stdin.fd : 'ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, options.wallTimeLimitMs);

    const finish = (spawnError?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const end = exitInfo?.at ?? performance.now();
      resolve({
        exitCode: exitInfo?.code ?? null,
        signal: exitInfo?.signal ?? null,
        timedOut,
        outputLimitExceeded,
        wallTimeMs: Math.round(end - start),
        memoryKb: null,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        spawnError,
      });
    };

    child.stdout!.on('data', (chunk: Buffer) => {
      if (outputLimitExceeded) return;
      const room = options.maxStdoutBytes - stdoutBytes;
      if (chunk.length > room) {
        if (room > 0) stdout.push(chunk.subarray(0, room));
        stdoutBytes = options.maxStdoutBytes;
        outputLimitExceeded = true;
        killGroup(child.pid);
        return;
      }
      stdout.push(chunk);
      stdoutBytes += chunk.length;
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      const room = maxStderr - stderrBytes;
      if (room <= 0) return;
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      stderr.push(part);
      stderrBytes += part.length;
    });

    child.on('exit', (code, signal) => {
      exitInfo = { code, signal, at: performance.now() };
      clearTimeout(timer);
      // Mata procesos huérfanos del grupo que puedan mantener abiertos stdout/stderr.
      killGroup(child.pid);
    });
    child.on('close', () => finish());
    child.on('error', (error) => finish(error));
  });

  await stdin?.close();

  if (useTime && !result.spawnError) {
    const content = await readFile(options.timeOutputPath!, 'utf8').catch(() => '');
    if (content) {
      const report = parseTimeReport(content);
      result.memoryKb = report.memoryKb;
      // Si GNU time alcanzó a reportar, su código/señal es el del programa (no el de time).
      if (result.signal === null) {
        result.exitCode = report.exitCode;
        result.signal = report.signal;
      }
    }
  }
  return result;
}
