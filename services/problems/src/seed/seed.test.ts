import { describe, expect, it } from 'vitest';
import { createFakeDb, FakeTestcaseStorage, silentLogger } from '../test-utils/fakes.js';
import { testcaseKeys } from '../storage/testcase-storage.js';
import { runSeed } from './run-seed.js';
import {
  mulberry32,
  randInt,
  SEED_PROBLEMS,
  solveAPlusB,
  solveArraySum,
  solveRangeSums,
} from './seed-data.js';

describe('soluciones de referencia', () => {
  it('A + B con enteros grandes', () => {
    expect(solveAPlusB('1000000000 1000000000\n')).toBe('2000000000\n');
    expect(solveAPlusB('-5 7')).toBe('2\n');
  });

  it('suma de arreglo', () => {
    expect(solveArraySum('3\n1 -2 3\n')).toBe('2\n');
  });

  it('suma en rangos coincide con la versión ingenua', () => {
    const rand = mulberry32(7);
    const a = Array.from({ length: 30 }, () => randInt(rand, -50, 50));
    const qs = Array.from({ length: 20 }, () => {
      const l = randInt(rand, 1, 30);
      return [l, randInt(rand, l, 30)] as const;
    });
    const input = `30 20\n${a.join(' ')}\n${qs.map(([l, r]) => `${l} ${r}`).join('\n')}\n`;
    const naive = qs.map(([l, r]) => a.slice(l - 1, r).reduce((s, v) => s + v, 0)).join('\n');
    expect(solveRangeSums(input)).toBe(`${naive}\n`);
  });
});

describe('SEED_PROBLEMS', () => {
  it('3 problemas publicables con casos deterministas', () => {
    expect(SEED_PROBLEMS.map((p) => p.slug)).toEqual([
      'a-mas-b',
      'suma-de-un-arreglo',
      'suma-en-rangos',
    ]);
    for (const p of SEED_PROBLEMS) {
      const first = p.testcases();
      expect(first.length).toBeGreaterThanOrEqual(3);
      expect(p.testcases().map((t) => t.output)).toEqual(first.map((t) => t.output));
      // El primer caso es el ejemplo del enunciado.
      expect(first[0]).toEqual({ input: p.examples[0]!.input, output: p.examples[0]!.output });
    }
  });

  it('el caso grande de suma en rangos provoca TLE con la solución ingenua', () => {
    const big = SEED_PROBLEMS[2]!.testcases().at(-1)!;
    const [n, q] = big.input.split(/\s+/, 2).map(Number);
    expect(n).toBe(200_000);
    expect(q).toBe(200_000);
  });
});

describe('runSeed', () => {
  it('hace upsert por slug, sube los casos y limpia los sobrantes', async () => {
    const { db, queries } = createFakeDb((q) =>
      q.sql.startsWith('insert into "problems"') ? [{ id: q.parameters[0] }] : [],
    );
    const storage = new FakeTestcaseStorage();
    const problem = { ...SEED_PROBLEMS[0]!, testcases: () => [{ input: '1 1\n', output: '2\n' }] };
    let n = 0;
    const results = await runSeed({
      db,
      storage,
      logger: silentLogger,
      problems: [problem],
      newId: () => `id-${++n}`,
    });

    expect(results).toEqual([{ slug: 'a-mas-b', problemId: 'id-1', testcases: 1 }]);
    expect(storage.bucketCreated).toBe(true);
    const keys = testcaseKeys('id-1', 1);
    expect(storage.objects.get(keys.input)).toBe('1 1\n');
    expect(storage.objects.get(keys.output)).toBe('2\n');
    const sql = queries.map((q) => q.sql);
    expect(sql[0]).toContain('on conflict ("slug") do update set');
    expect(sql[1]).toContain('on conflict ("problem_id", "ordinal") do update set');
    expect(sql[2]).toBe('delete from "testcases" where "problem_id" = $1 and "ordinal" > $2');
  });
});
