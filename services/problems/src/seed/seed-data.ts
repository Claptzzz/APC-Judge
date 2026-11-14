import type { DifficultyDb, ExampleRow } from '../db/schema.js';

export interface SeedTestcase {
  input: string;
  output: string;
}

export interface SeedProblem {
  slug: string;
  title: string;
  statement: string;
  difficulty: DifficultyDb;
  tags: string[];
  timeLimitMs: number;
  memoryLimitMb: number;
  examples: ExampleRow[];
  /** Se generan al sembrar (los casos grandes no se guardan en el código). */
  testcases: () => SeedTestcase[];
}

/** Autor de los problemas de ejemplo (usuario "sistema"; no existe en users). */
export const SEED_AUTHOR_ID = '00000000-0000-4000-8000-000000000001';

/** PRNG determinista (mulberry32): mismos casos en cada ejecución del seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function randInt(rand: () => number, min: number, max: number): number {
  return min + Math.floor(rand() * (max - min + 1));
}

const MAX_ABS = 1_000_000_000;

export function solveAPlusB(input: string): string {
  const [a = 0n, b = 0n] = input.trim().split(/\s+/).map(BigInt);
  return `${a + b}\n`;
}

export function solveArraySum(input: string): string {
  const [, ...values] = input.trim().split(/\s+/);
  return `${values.reduce((acc, v) => acc + BigInt(v), 0n)}\n`;
}

export function solveRangeSums(input: string): string {
  const tokens = input.trim().split(/\s+/).map(Number);
  const [n = 0, q = 0] = tokens;
  // |suma| ≤ 2·10^5 · 10^9 = 2·10^14 < 2^53: alcanza con number.
  const prefix = new Array<number>(n + 1);
  prefix[0] = 0;
  for (let i = 1; i <= n; i++) prefix[i] = prefix[i - 1]! + tokens[1 + i]!;
  const out: string[] = [];
  for (let k = 0; k < q; k++) {
    const l = tokens[2 + n + 2 * k]!;
    const r = tokens[3 + n + 2 * k]!;
    out.push(String(prefix[r]! - prefix[l - 1]!));
  }
  return `${out.join('\n')}\n`;
}

function withOutput(solve: (input: string) => string, inputs: string[]): SeedTestcase[] {
  return inputs.map((input) => ({ input, output: solve(input) }));
}

function arrayInput(values: number[]): string {
  return `${values.length}\n${values.join(' ')}\n`;
}

function randomArray(rand: () => number, n: number, min = -MAX_ABS, max = MAX_ABS): number[] {
  return Array.from({ length: n }, () => randInt(rand, min, max));
}

function rangeInput(values: number[], queries: Array<[number, number]>): string {
  const lines = queries.map(([l, r]) => `${l} ${r}`).join('\n');
  return `${values.length} ${queries.length}\n${values.join(' ')}\n${lines}\n`;
}

export const SEED_PROBLEMS: SeedProblem[] = [
  {
    slug: 'a-mas-b',
    title: 'A + B',
    difficulty: 'EASY',
    tags: ['matematicas', 'implementacion'],
    timeLimitMs: 1_000,
    memoryLimitMb: 256,
    statement: [
      'Dados dos enteros $A$ y $B$, imprime $A + B$.',
      '',
      '## Entrada',
      'Una línea con dos enteros $A$ y $B$ ($-10^9 \\le A, B \\le 10^9$).',
      '',
      '## Salida',
      'Un entero: $A + B$.',
      '',
      '> Ojo: la suma puede no caber en un entero de 32 bits.',
    ].join('\n'),
    examples: [
      { input: '1 2\n', output: '3\n', explanation: '1 + 2 = 3.' },
      { input: '-5 7\n', output: '2\n', explanation: '' },
    ],
    testcases: () =>
      withOutput(solveAPlusB, [
        '1 2\n',
        '-5 7\n',
        '0 0\n',
        '1000000000 1000000000\n',
        '-1000000000 -999999999\n',
      ]),
  },
  {
    slug: 'suma-de-un-arreglo',
    title: 'Suma de un arreglo',
    difficulty: 'EASY',
    tags: ['arreglos', 'implementacion'],
    timeLimitMs: 1_000,
    memoryLimitMb: 256,
    statement: [
      'Dado un arreglo de $N$ enteros, imprime la suma de todos sus elementos.',
      '',
      '## Entrada',
      'La primera línea contiene $N$ ($1 \\le N \\le 2 \\cdot 10^5$).',
      'La segunda línea contiene $N$ enteros $a_i$ ($-10^9 \\le a_i \\le 10^9$).',
      '',
      '## Salida',
      'Un entero: $\\sum a_i$. Usa enteros de 64 bits.',
    ].join('\n'),
    examples: [{ input: '5\n1 2 3 4 5\n', output: '15\n', explanation: '1 + 2 + 3 + 4 + 5 = 15.' }],
    testcases: () => {
      const rand = mulberry32(20_261_111);
      return withOutput(solveArraySum, [
        arrayInput([1, 2, 3, 4, 5]),
        arrayInput([-7]),
        arrayInput(randomArray(rand, 1_000)),
        arrayInput(randomArray(rand, 200_000)),
        arrayInput(new Array<number>(200_000).fill(MAX_ABS)),
      ]);
    },
  },
  {
    slug: 'suma-en-rangos',
    title: 'Suma en rangos',
    difficulty: 'MEDIUM',
    tags: ['sumas-prefijas', 'arreglos'],
    timeLimitMs: 1_000,
    memoryLimitMb: 256,
    statement: [
      'Dado un arreglo $a_1, \\dots, a_N$, responde $Q$ consultas: para cada par $(l, r)$ imprime',
      '$a_l + a_{l+1} + \\dots + a_r$.',
      '',
      '## Entrada',
      'La primera línea contiene $N$ y $Q$ ($1 \\le N, Q \\le 2 \\cdot 10^5$).',
      'La segunda línea contiene $N$ enteros $a_i$ ($-10^9 \\le a_i \\le 10^9$).',
      'Cada una de las siguientes $Q$ líneas contiene $l$ y $r$ ($1 \\le l \\le r \\le N$).',
      '',
      '## Salida',
      'Para cada consulta, una línea con la suma pedida.',
      '',
      '> Recorrer el rango en cada consulta es $O(N \\cdot Q)$ y no alcanza el límite de tiempo:',
      '> usa sumas prefijas.',
    ].join('\n'),
    examples: [
      {
        input: '5 3\n1 2 3 4 5\n1 5\n2 3\n4 4\n',
        output: '15\n5\n4\n',
        explanation: 'a1+…+a5 = 15, a2+a3 = 5 y a4 = 4.',
      },
    ],
    testcases: () => {
      const rand = mulberry32(42);
      const small = randomArray(rand, 10, -100, 100);
      const smallQueries = Array.from({ length: 10 }, (): [number, number] => {
        const l = randInt(rand, 1, 10);
        return [l, randInt(rand, l, 10)];
      });
      // Caso grande con rangos casi completos: la solución ingenua hace ~4·10^10 sumas (TLE).
      const n = 200_000;
      const big = randomArray(rand, n);
      const bigQueries = Array.from({ length: 200_000 }, (): [number, number] => [
        randInt(rand, 1, 1_000),
        randInt(rand, n - 1_000, n),
      ]);
      return withOutput(solveRangeSums, [
        rangeInput(
          [1, 2, 3, 4, 5],
          [
            [1, 5],
            [2, 3],
            [4, 4],
          ],
        ),
        rangeInput(small, smallQueries),
        rangeInput(big, bigQueries),
      ]);
    },
  },
];
