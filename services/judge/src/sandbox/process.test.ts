import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectSandbox } from './capabilities.js';
import type { SandboxCapabilities } from './capabilities.js';
import { buildCommand, parseTimeReport, runProcess } from './process.js';

let dir: string;
let sandbox: SandboxCapabilities;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'judge-proc-'));
  sandbox = await detectSandbox();
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fake: SandboxCapabilities = {
  prlimit: '/usr/bin/prlimit',
  unshare: '/usr/bin/unshare',
  time: '/usr/bin/time',
};

describe('buildCommand', () => {
  it('envuelve con unshare -rn, GNU time y prlimit', () => {
    const argv = buildCommand({
      command: './main',
      args: ['a'],
      cwd: '/w',
      sandbox: fake,
      wallTimeLimitMs: 1000,
      memoryLimitMb: 64,
      cpuTimeLimitS: 2,
      fileSizeLimitBytes: 1024,
      maxStdoutBytes: 10,
      timeOutputPath: '/w/time.txt',
    });
    expect(argv).toEqual([
      '/usr/bin/unshare',
      '-rn',
      '--',
      '/usr/bin/time',
      '-f',
      '%M',
      '-o',
      '/w/time.txt',
      '/usr/bin/prlimit',
      '--core=0',
      `--as=${64 * 1024 * 1024}`,
      '--cpu=2',
      '--fsize=1024',
      '--',
      './main',
      'a',
    ]);
  });

  it('omite unshare y time si no están disponibles', () => {
    const argv = buildCommand({
      command: 'g++',
      args: [],
      cwd: '/w',
      sandbox: { prlimit: 'prlimit', unshare: null, time: null },
      wallTimeLimitMs: 1000,
      maxStdoutBytes: 10,
      timeOutputPath: '/w/time.txt',
    });
    expect(argv).toEqual(['prlimit', '--core=0', '--', 'g++']);
  });
});

describe('parseTimeReport', () => {
  it('lee la memoria y el estado de salida del programa', () => {
    expect(parseTimeReport('1234\n')).toEqual({ memoryKb: 1234, exitCode: 0, signal: null });
    expect(parseTimeReport('Command exited with non-zero status 3\n2048\n')).toEqual({
      memoryKb: 2048,
      exitCode: 3,
      signal: null,
    });
    expect(parseTimeReport('Command terminated by signal 9\n4096\n')).toEqual({
      memoryKb: 4096,
      exitCode: null,
      signal: 'SIGKILL',
    });
    expect(parseTimeReport('Command terminated by signal 200\n').signal).toBe('SIG200');
  });
});

describe('runProcess', () => {
  const base = () => ({
    cwd: dir,
    sandbox,
    wallTimeLimitMs: 5_000,
    maxStdoutBytes: 1024 * 1024,
    timeOutputPath: join(dir, 'time.txt'),
  });

  it('conecta stdin desde un archivo y captura stdout/stderr', async () => {
    await writeFile(join(dir, 'in.txt'), 'hola\n');
    const result = await runProcess({
      ...base(),
      command: 'sh',
      args: ['-c', 'cat; echo error >&2; exit 3'],
      stdinPath: join(dir, 'in.txt'),
    });
    expect(result.stdout.toString()).toBe('hola\n');
    expect(result.stderr.toString()).toBe('error\n');
    expect(result.exitCode).toBe(3);
    expect(result.signal).toBeNull();
    expect(result.timedOut).toBe(false);
    if (sandbox.time) expect(result.memoryKb).toBeGreaterThan(0);
  });

  it('mata el grupo de procesos al vencer el tiempo de pared', async () => {
    const result = await runProcess({
      ...base(),
      command: 'sh',
      args: ['-c', 'sleep 5 & wait'],
      wallTimeLimitMs: 300,
    });
    expect(result.timedOut).toBe(true);
    expect(result.wallTimeMs).toBeLessThan(3_000);
  });

  it('corta la salida que excede el máximo', async () => {
    const result = await runProcess({ ...base(), command: 'yes', args: [], maxStdoutBytes: 1000 });
    expect(result.outputLimitExceeded).toBe(true);
    expect(result.stdout.length).toBe(1000);
  });

  it('trunca stderr sin matar el proceso', async () => {
    const result = await runProcess({
      ...base(),
      command: 'sh',
      args: ['-c', 'head -c 5000 /dev/zero >&2'],
      maxStderrBytes: 100,
    });
    expect(result.stderr.length).toBe(100);
    expect(result.exitCode).toBe(0);
  });

  it('reporta el error si no se puede lanzar el proceso', async () => {
    const result = await runProcess({
      ...base(),
      sandbox: { prlimit: '/no/existe/prlimit', unshare: null, time: null },
      command: 'true',
      args: [],
    });
    expect(result.spawnError).toBeInstanceOf(Error);
  });

  it.runIf(sandbox?.unshare !== null)('sin red cuando unshare -rn está disponible', async () => {
    if (!sandbox.unshare) return;
    const result = await runProcess({
      ...base(),
      command: 'python3',
      args: ['-c', 'import socket; socket.create_connection(("1.1.1.1", 53), timeout=2)'],
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toMatch(/unreachable|OSError/i);
  });
});
