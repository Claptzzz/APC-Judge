import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Language, Verdict } from '@juez/contracts/es';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { classifyRun, judgeSubmission, launchFailed } from './judge.js';
import type { JudgeDeps } from './judge.js';
import { detectSandbox } from './sandbox/capabilities.js';
import type { SandboxCapabilities } from './sandbox/capabilities.js';
import type { RunResult } from './sandbox/process.js';
import { makeSpec, makeSubmission, memoryDownloader, silentLogger } from './test-utils/index.js';
import type { FakeCase } from './test-utils/index.js';

let workdir: string;
let sandbox: SandboxCapabilities;

beforeAll(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'judge-test-'));
  sandbox = await detectSandbox();
});
afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
});

const SUM_CASES: FakeCase[] = [
  { input: '1 2\n', output: '3\n' },
  { input: '10 -4\n', output: '6' },
  { input: '100 200\n', output: '300\n' },
];

interface Scenario {
  cases?: FakeCase[];
  timeLimitMs?: number;
  memoryLimitMb?: number;
  maxOutputBytes?: number;
}

function deps(scenario: Scenario = {}): JudgeDeps {
  const cases = scenario.cases ?? SUM_CASES;
  const spec = makeSpec(cases, {
    timeLimitMs: scenario.timeLimitMs ?? 2_000,
    memoryLimitMb: scenario.memoryLimitMb ?? 256,
  });
  return {
    problems: { getJudgeSpec: vi.fn(async () => spec) },
    download: memoryDownloader(cases),
    sandbox,
    settings: {
      workdir,
      compileTimeoutMs: 30_000,
      maxOutputBytes: scenario.maxOutputBytes ?? 1024 * 1024,
    },
    logger: silentLogger,
  };
}

async function judge(language: Language, sourceCode: string, scenario?: Scenario) {
  return judgeSubmission(makeSubmission({ language, sourceCode }), deps(scenario), {
    requestId: 'r',
  });
}

const CPP = {
  accepted: '#include <iostream>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a+b<<"\\n";}',
  // Falla solo en el segundo caso (a+b con b negativo).
  wrongOnSecond:
    '#include <iostream>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<(b<0?a-b:a+b)<<"\\n";}',
  tle: 'int main(){volatile unsigned long x=0;for(;;)x++;}',
  // El tamaño depende de la entrada para que el compilador no elimine la reserva.
  mle: '#include <vector>\n#include <cstdio>\nint main(){long long a,b;std::scanf("%lld %lld",&a,&b);std::vector<char> v((1ull<<30)+a);for(size_t i=0;i<v.size();i+=4096)v[i]=char(i);long long s=0;for(size_t i=0;i<v.size();i+=4096)s+=v[i];std::printf("%lld\\n",s);}',
  rte: '#include <cstdlib>\nint main(){std::abort();}',
  ce: 'int main(){ return }',
};

const PY = {
  accepted: 'a, b = map(int, input().split())\nprint(a + b)\n',
  wrongOnSecond: 'a, b = map(int, input().split())\nprint(a - b if b < 0 else a + b)\n',
  tle: 'while True:\n    pass\n',
  mle: 'x = bytearray(512 * 1024 * 1024)\nprint(len(x))\n',
  rte: 'raise SystemExit(1/0)\n',
  ce: 'def f(:\n    pass\n',
  flood: 'import sys\nsys.stdout.write("x" * (4 * 1024 * 1024))\n',
};

describe('judgeSubmission con C++ (g++ -O2 -std=gnu++17)', () => {
  it('ACCEPTED: pasa todos los casos y mide tiempo y memoria', async () => {
    const result = await judge(Language.CPP17, CPP.accepted);
    expect(result).toMatchObject({ verdict: Verdict.ACCEPTED, passedCases: 3, totalCases: 3 });
    expect(result.timeMs).toBeGreaterThanOrEqual(0);
    if (sandbox.time) expect(result.memoryKb).toBeGreaterThan(0);
  });

  it('WRONG_ANSWER: se detiene en el primer caso fallido', async () => {
    expect(await judge(Language.CPP17, CPP.wrongOnSecond)).toMatchObject({
      verdict: Verdict.WRONG_ANSWER,
      passedCases: 1,
      totalCases: 3,
    });
  });

  it('TIME_LIMIT_EXCEEDED', async () => {
    const result = await judge(Language.CPP17, CPP.tle, { timeLimitMs: 300 });
    expect(result).toMatchObject({ verdict: Verdict.TIME_LIMIT_EXCEEDED, passedCases: 0 });
    expect(result.timeMs).toBe(300);
  });

  it('MEMORY_LIMIT_EXCEEDED', async () => {
    expect(await judge(Language.CPP17, CPP.mle, { memoryLimitMb: 64 })).toMatchObject({
      verdict: Verdict.MEMORY_LIMIT_EXCEEDED,
      passedCases: 0,
    });
  });

  it('RUNTIME_ERROR', async () => {
    expect(await judge(Language.CPP17, CPP.rte)).toMatchObject({
      verdict: Verdict.RUNTIME_ERROR,
      passedCases: 0,
    });
  });

  it('COMPILATION_ERROR', async () => {
    expect(await judge(Language.CPP17, CPP.ce)).toEqual({
      verdict: Verdict.COMPILATION_ERROR,
      timeMs: 0,
      memoryKb: 0,
      passedCases: 0,
      totalCases: 3,
    });
  });
});

describe('judgeSubmission con Python 3', () => {
  it('ACCEPTED', async () => {
    expect(await judge(Language.PYTHON3, PY.accepted)).toMatchObject({
      verdict: Verdict.ACCEPTED,
      passedCases: 3,
    });
  });

  it('WRONG_ANSWER', async () => {
    expect(await judge(Language.PYTHON3, PY.wrongOnSecond)).toMatchObject({
      verdict: Verdict.WRONG_ANSWER,
      passedCases: 1,
    });
  });

  it('TIME_LIMIT_EXCEEDED', async () => {
    expect(await judge(Language.PYTHON3, PY.tle, { timeLimitMs: 300 })).toMatchObject({
      verdict: Verdict.TIME_LIMIT_EXCEEDED,
    });
  });

  it('MEMORY_LIMIT_EXCEEDED', async () => {
    expect(await judge(Language.PYTHON3, PY.mle, { memoryLimitMb: 64 })).toMatchObject({
      verdict: Verdict.MEMORY_LIMIT_EXCEEDED,
    });
  });

  it('RUNTIME_ERROR', async () => {
    expect(await judge(Language.PYTHON3, PY.rte)).toMatchObject({ verdict: Verdict.RUNTIME_ERROR });
  });

  it('COMPILATION_ERROR (py_compile)', async () => {
    expect(await judge(Language.PYTHON3, PY.ce)).toMatchObject({
      verdict: Verdict.COMPILATION_ERROR,
    });
  });

  it('salida sobre el máximo: RUNTIME_ERROR', async () => {
    expect(await judge(Language.PYTHON3, PY.flood, { maxOutputBytes: 1024 })).toMatchObject({
      verdict: Verdict.RUNTIME_ERROR,
    });
  });
});

describe('judgeSubmission: errores del juez y casos borde', () => {
  it('INTERNAL_ERROR si problems no responde', async () => {
    const d = deps();
    d.problems.getJudgeSpec = vi.fn(async () => {
      throw new Error('Unavailable');
    });
    const result = await judgeSubmission(makeSubmission({ sourceCode: CPP.accepted }), d, {
      requestId: 'r',
    });
    expect(result).toEqual({
      verdict: Verdict.INTERNAL_ERROR,
      timeMs: 0,
      memoryKb: 0,
      passedCases: 0,
      totalCases: 0,
    });
  });

  it('INTERNAL_ERROR si el problema no tiene casos', async () => {
    expect(await judge(Language.CPP17, CPP.accepted, { cases: [] })).toMatchObject({
      verdict: Verdict.INTERNAL_ERROR,
      totalCases: 0,
    });
  });

  it('INTERNAL_ERROR si falla la descarga', async () => {
    const d = deps();
    d.download = async () => {
      throw new Error('403');
    };
    const result = await judgeSubmission(makeSubmission({ sourceCode: CPP.accepted }), d, {
      requestId: 'r',
    });
    expect(result).toMatchObject({ verdict: Verdict.INTERNAL_ERROR, totalCases: 3 });
  });

  it('INTERNAL_ERROR si no se puede lanzar el compilador', async () => {
    const d = deps();
    d.sandbox = { ...sandbox, prlimit: '/no/existe/prlimit' };
    const result = await judgeSubmission(makeSubmission({ sourceCode: CPP.accepted }), d, {
      requestId: 'r',
    });
    expect(result.verdict).toBe(Verdict.INTERNAL_ERROR);
  });

  it('funciona en modo degradado, sin unshare ni GNU time', async () => {
    const d = deps();
    d.sandbox = { prlimit: sandbox.prlimit, unshare: null, time: null };
    const submission = makeSubmission({ language: Language.PYTHON3, sourceCode: PY.accepted });
    expect(await judgeSubmission(submission, d, { requestId: 'r' })).toMatchObject({
      verdict: Verdict.ACCEPTED,
      memoryKb: 0,
    });
  });

  it('COMPILATION_ERROR para un lenguaje no soportado', async () => {
    expect(await judge(Language.UNSPECIFIED, 'x')).toMatchObject({
      verdict: Verdict.COMPILATION_ERROR,
      totalCases: 3,
    });
  });

  it('siempre borra el directorio temporal', async () => {
    await judge(Language.PYTHON3, PY.accepted);
    await judge(Language.CPP17, CPP.ce);
    expect(await readdir(workdir)).toEqual([]);
  });
});

describe('launchFailed', () => {
  const base: RunResult = {
    exitCode: 127,
    signal: null,
    timedOut: false,
    outputLimitExceeded: false,
    wallTimeMs: 1,
    memoryKb: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.from('prlimit: failed to execute g++: No such file or directory'),
  };

  it('distingue fallas del entorno de fallas del programa', () => {
    expect(launchFailed(base)).toBe(true);
    expect(
      launchFailed({
        ...base,
        stderr: Buffer.from('/usr/bin/unshare: failed to execute x: Permission denied'),
      }),
    ).toBe(true);
    expect(
      launchFailed({
        ...base,
        stderr: Buffer.from('prlimit: failed to execute ./main: Cannot allocate memory'),
      }),
    ).toBe(false);
    expect(launchFailed({ ...base, exitCode: 1 })).toBe(false);
    expect(launchFailed({ ...base, stderr: Buffer.from('otro error') })).toBe(false);
    expect(launchFailed({ ...base, exitCode: null, spawnError: new Error('ENOENT') })).toBe(true);
  });
});

describe('classifyRun', () => {
  const run = (overrides: Partial<RunResult>): RunResult => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    outputLimitExceeded: false,
    wallTimeMs: 10,
    memoryKb: 1000,
    stdout: Buffer.from('ok'),
    stderr: Buffer.alloc(0),
    ...overrides,
  });
  const limits = { timeLimitMs: 1000, memoryLimitMb: 64 };
  const expected = Buffer.from('ok\n');

  it('prioriza TLE, luego salida excedida, memoria, error y comparación', () => {
    expect(classifyRun(run({ signal: 'SIGXCPU', exitCode: null }), limits, expected)).toBe(
      Verdict.TIME_LIMIT_EXCEEDED,
    );
    expect(classifyRun(run({ wallTimeMs: 1001 }), limits, expected)).toBe(
      Verdict.TIME_LIMIT_EXCEEDED,
    );
    expect(classifyRun(run({ outputLimitExceeded: true }), limits, expected)).toBe(
      Verdict.RUNTIME_ERROR,
    );
    expect(classifyRun(run({ memoryKb: 64 * 1024 + 1 }), limits, expected)).toBe(
      Verdict.MEMORY_LIMIT_EXCEEDED,
    );
    expect(
      classifyRun(
        run({
          exitCode: 1,
          stderr: Buffer.from('prlimit: failed to execute ./main: Cannot allocate memory'),
        }),
        limits,
        expected,
      ),
    ).toBe(Verdict.MEMORY_LIMIT_EXCEEDED);
    expect(classifyRun(run({ exitCode: null, signal: 'SIGSEGV' }), limits, expected)).toBe(
      Verdict.RUNTIME_ERROR,
    );
    expect(classifyRun(run({ memoryKb: null }), limits, expected)).toBe(Verdict.ACCEPTED);
    expect(classifyRun(run({ stdout: Buffer.from('no') }), limits, expected)).toBe(
      Verdict.WRONG_ANSWER,
    );
  });
});
