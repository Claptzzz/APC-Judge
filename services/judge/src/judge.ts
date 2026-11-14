import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Verdict } from '@juez/contracts/es';
import type { GetJudgeSpecResponse, SubmissionCreated } from '@juez/contracts/es';
import { tokensEqual } from './compare.js';
import type { Logger } from './logger.js';
import type { JudgeSpecSource } from './problems-client.js';
import type { SandboxCapabilities } from './sandbox/capabilities.js';
import { languageSpec } from './sandbox/languages.js';
import { runProcess } from './sandbox/process.js';
import type { RunResult } from './sandbox/process.js';
import type { DownloadedCase } from './testcases.js';

export interface JudgeOutcome {
  verdict: Verdict;
  /** Máximo entre los casos ejecutados. */
  timeMs: number;
  /** Máximo RSS entre los casos ejecutados (0 si no se pudo medir). */
  memoryKb: number;
  passedCases: number;
  totalCases: number;
}

export interface JudgeSettings {
  /** Directorio base donde se crea un subdirectorio temporal por submission. */
  workdir: string;
  compileTimeoutMs: number;
  maxOutputBytes: number;
}

export interface JudgeDeps {
  problems: JudgeSpecSource;
  download: (spec: GetJudgeSpecResponse, dir: string) => Promise<DownloadedCase[]>;
  sandbox: SandboxCapabilities;
  settings: JudgeSettings;
  logger: Logger;
}

export interface JudgeContext {
  requestId: string;
}

/** Mensajes con los que g++/libstdc++, CPython y util-linux reportan falta de memoria. */
const OUT_OF_MEMORY_RE = /std::bad_alloc|MemoryError|Cannot allocate memory|out of memory/i;
/** prlimit/unshare/GNU time no pudieron ejecutar el comando (p. ej. falta g++ o python3). */
const LAUNCH_FAILURE_RE = /^(?:\S*\/)?(?:prlimit|unshare|time): (?:failed to execute|cannot run)/m;
const MAX_STDERR_BYTES = 64 * 1024;
const COMPILE_FILE_SIZE_LIMIT = 256 * 1024 * 1024;

export interface CaseLimits {
  timeLimitMs: number;
  memoryLimitMb: number;
}

export type CaseVerdict =
  | Verdict.ACCEPTED
  | Verdict.WRONG_ANSWER
  | Verdict.TIME_LIMIT_EXCEEDED
  | Verdict.MEMORY_LIMIT_EXCEEDED
  | Verdict.RUNTIME_ERROR;

/**
 * Veredicto de un caso a partir de la ejecución. Orden: TLE (pared o SIGXCPU), salida
 * excedida (RE), memoria (RSS sobre el límite o error de asignación), error de ejecución y
 * por último la comparación por tokens.
 */
export function classifyRun(run: RunResult, limits: CaseLimits, expected: Uint8Array): CaseVerdict {
  if (run.timedOut || run.signal === 'SIGXCPU' || run.wallTimeMs > limits.timeLimitMs) {
    return Verdict.TIME_LIMIT_EXCEEDED;
  }
  if (run.outputLimitExceeded) return Verdict.RUNTIME_ERROR;
  if (run.memoryKb !== null && run.memoryKb > limits.memoryLimitMb * 1024) {
    return Verdict.MEMORY_LIMIT_EXCEEDED;
  }
  const failed = run.exitCode !== 0 || run.signal !== null;
  if (failed) {
    return OUT_OF_MEMORY_RE.test(run.stderr.toString('utf8'))
      ? Verdict.MEMORY_LIMIT_EXCEEDED
      : Verdict.RUNTIME_ERROR;
  }
  return tokensEqual(run.stdout, expected) ? Verdict.ACCEPTED : Verdict.WRONG_ANSWER;
}

/**
 * El comando no llegó a ejecutarse por una falla del entorno del juez (no del programa).
 * Un exec que falla por falta de memoria (`--as`) sí es culpa del programa: MLE.
 */
export function launchFailed(run: RunResult): boolean {
  if (run.spawnError) return true;
  if (run.exitCode !== 126 && run.exitCode !== 127) return false;
  const stderr = run.stderr.toString('utf8');
  return LAUNCH_FAILURE_RE.test(stderr) && !OUT_OF_MEMORY_RE.test(stderr);
}

function outcome(
  verdict: Verdict,
  totalCases: number,
  extra: Partial<JudgeOutcome> = {},
): JudgeOutcome {
  return { verdict, timeMs: 0, memoryKb: 0, passedCases: 0, totalCases, ...extra };
}

/**
 * Evalúa una submission: GetJudgeSpec → descarga de casos → compilación → ejecución de cada
 * caso hasta el primer fallo. Nunca lanza: cualquier falla del juez es INTERNAL_ERROR.
 * El directorio temporal se borra siempre.
 */
export async function judgeSubmission(
  submission: SubmissionCreated,
  deps: JudgeDeps,
  ctx: JudgeContext,
): Promise<JudgeOutcome> {
  const log = deps.logger.child({
    submissionId: submission.submissionId,
    problemId: submission.problemId,
    requestId: ctx.requestId,
  });

  let spec: GetJudgeSpecResponse;
  try {
    spec = await deps.problems.getJudgeSpec(submission.problemId, ctx.requestId);
  } catch (error) {
    log.error({ err: error }, 'GetJudgeSpec falló después de los reintentos');
    return outcome(Verdict.INTERNAL_ERROR, 0);
  }

  const totalCases = spec.testcases.length;
  if (totalCases === 0 || spec.timeLimitMs <= 0 || spec.memoryLimitMb <= 0) {
    log.error(
      { totalCases, timeLimitMs: spec.timeLimitMs, memoryLimitMb: spec.memoryLimitMb },
      'JudgeSpec inválido (sin casos o sin límites)',
    );
    return outcome(Verdict.INTERNAL_ERROR, totalCases);
  }

  const lang = languageSpec(submission.language);
  if (!lang) {
    log.warn({ language: submission.language }, 'lenguaje no soportado');
    return outcome(Verdict.COMPILATION_ERROR, totalCases);
  }

  await mkdir(deps.settings.workdir, { recursive: true });
  const root = await mkdtemp(join(deps.settings.workdir, 'sub-'));
  try {
    return await judgeInDir(root, submission, spec, lang, deps, log);
  } catch (error) {
    log.error({ err: error }, 'error interno del juez');
    return outcome(Verdict.INTERNAL_ERROR, totalCases);
  } finally {
    await rm(root, { recursive: true, force: true }).catch((error: unknown) =>
      log.error({ err: error, dir: root }, 'no se pudo borrar el directorio temporal'),
    );
  }
}

async function judgeInDir(
  root: string,
  submission: SubmissionCreated,
  spec: GetJudgeSpecResponse,
  lang: NonNullable<ReturnType<typeof languageSpec>>,
  deps: JudgeDeps,
  log: Logger,
): Promise<JudgeOutcome> {
  const totalCases = spec.testcases.length;
  const { sandbox, settings } = deps;
  const box = join(root, 'box');
  await mkdir(box);

  let cases: DownloadedCase[];
  try {
    cases = await deps.download(spec, join(root, 'cases'));
  } catch (error) {
    log.error({ err: error }, 'no se pudieron descargar los casos de prueba');
    return outcome(Verdict.INTERNAL_ERROR, totalCases);
  }

  await writeFile(join(box, lang.sourceFile), submission.sourceCode);

  const compile = lang.compile(box);
  const compiled = await runProcess({
    ...compile,
    cwd: box,
    sandbox,
    wallTimeLimitMs: settings.compileTimeoutMs,
    cpuTimeLimitS: Math.ceil(settings.compileTimeoutMs / 1000) + 1,
    fileSizeLimitBytes: COMPILE_FILE_SIZE_LIMIT,
    maxStdoutBytes: MAX_STDERR_BYTES,
    maxStderrBytes: MAX_STDERR_BYTES,
  });
  if (launchFailed(compiled)) {
    log.error(
      {
        err: compiled.spawnError,
        stderr: compiled.stderr.toString('utf8'),
        command: compile.command,
      },
      'no se pudo ejecutar el compilador',
    );
    return outcome(Verdict.INTERNAL_ERROR, totalCases);
  }
  if (compiled.timedOut || compiled.exitCode !== 0 || compiled.signal !== null) {
    log.info({ timedOut: compiled.timedOut, exitCode: compiled.exitCode }, 'error de compilación');
    return outcome(Verdict.COMPILATION_ERROR, totalCases);
  }

  const limits: CaseLimits = { timeLimitMs: spec.timeLimitMs, memoryLimitMb: spec.memoryLimitMb };
  const run = lang.run(box);
  let timeMs = 0;
  let memoryKb = 0;
  let passedCases = 0;
  for (const tc of cases) {
    const result = await runProcess({
      ...run,
      cwd: box,
      sandbox,
      stdinPath: tc.inputPath,
      wallTimeLimitMs: limits.timeLimitMs,
      memoryLimitMb: limits.memoryLimitMb,
      cpuTimeLimitS: Math.ceil(limits.timeLimitMs / 1000) + 1,
      fileSizeLimitBytes: settings.maxOutputBytes,
      maxStdoutBytes: settings.maxOutputBytes,
      maxStderrBytes: MAX_STDERR_BYTES,
      timeOutputPath: join(root, 'time.txt'),
    });
    if (launchFailed(result)) {
      log.error(
        { err: result.spawnError, stderr: result.stderr.toString('utf8'), command: run.command },
        'no se pudo ejecutar el programa',
      );
      return outcome(Verdict.INTERNAL_ERROR, totalCases, { timeMs, memoryKb, passedCases });
    }
    timeMs = Math.max(timeMs, Math.min(result.wallTimeMs, limits.timeLimitMs));
    memoryKb = Math.max(memoryKb, result.memoryKb ?? 0);

    const expected = await readFile(tc.outputPath);
    const verdict = classifyRun(result, limits, expected);
    log.debug(
      {
        ordinal: tc.ordinal,
        verdict: Verdict[verdict],
        wallTimeMs: result.wallTimeMs,
        memoryKb: result.memoryKb,
      },
      'caso evaluado',
    );
    if (verdict !== Verdict.ACCEPTED) {
      return { verdict, timeMs, memoryKb, passedCases, totalCases };
    }
    passedCases++;
  }
  return { verdict: Verdict.ACCEPTED, timeMs, memoryKb, passedCases, totalCases };
}
