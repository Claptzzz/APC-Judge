import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import {
  CreateProblemRequestSchema,
  Difficulty,
  UpdateProblemRequestSchema,
} from '@juez/contracts/es';
import { describe, expect, it } from 'vitest';
import { isValidSlug, slugCandidate, slugify } from './slug.js';
import {
  decodePageToken,
  difficultyFromDb,
  difficultyToDb,
  encodePageToken,
  normalizeTags,
  pageSize,
  requireUuid,
  validateCreate,
  validateOrdinal,
  validateUpdate,
} from './validation.js';

const invalidArg = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectError);
    expect((err as ConnectError).code).toBe(Code.InvalidArgument);
    return (err as ConnectError).rawMessage;
  }
  throw new Error('se esperaba INVALID_ARGUMENT');
};

describe('slug', () => {
  it('genera slugs sin tildes ni símbolos', () => {
    expect(slugify('Suma de Dos Números')).toBe('suma-de-dos-numeros');
    expect(slugify('A + B')).toBe('a-mas-b');
    expect(slugify('  ¿Ñandú?  ')).toBe('nandu');
    expect(slugify('!!!')).toBe('problema');
    expect(slugify('x'.repeat(200)).length).toBeLessThanOrEqual(76);
  });

  it('valida el formato', () => {
    expect(isValidSlug('a-mas-b')).toBe(true);
    expect(isValidSlug('A-B')).toBe(false);
    expect(isValidSlug('a--b')).toBe(false);
    expect(isValidSlug('-a')).toBe(false);
    expect(isValidSlug('a'.repeat(81))).toBe(false);
  });

  it('genera candidatos con sufijo', () => {
    expect(slugCandidate('x', 1)).toBe('x');
    expect(slugCandidate('x', 3)).toBe('x-3');
  });
});

describe('validateCreate', () => {
  const base = { title: ' Título ', difficulty: Difficulty.MEDIUM };

  it('normaliza y aplica defaults', () => {
    const v = validateCreate(
      create(CreateProblemRequestSchema, { ...base, examples: [{ input: '1', output: '2' }] }),
    );
    expect(v).toEqual({
      slug: undefined,
      title: 'Título',
      statement: '',
      difficulty: 'MEDIUM',
      tags: [],
      timeLimitMs: 1000,
      memoryLimitMb: 256,
      examples: [{ input: '1', output: '2', explanation: '' }],
    });
  });

  it('respeta slug y límites explícitos', () => {
    const v = validateCreate(
      create(CreateProblemRequestSchema, {
        ...base,
        slug: 'mi-slug',
        timeLimitMs: 2500,
        memoryLimitMb: 512,
      }),
    );
    expect(v).toMatchObject({ slug: 'mi-slug', timeLimitMs: 2500, memoryLimitMb: 512 });
  });

  it('rechaza valores fuera de rango', () => {
    const req = (init: object) => create(CreateProblemRequestSchema, { ...base, ...init });
    expect(invalidArg(() => validateCreate(req({ title: '' })))).toMatch(/title/);
    expect(invalidArg(() => validateCreate(req({ title: 'x'.repeat(201) })))).toMatch(/title/);
    expect(invalidArg(() => validateCreate(req({ statement: 'x'.repeat(100_001) })))).toMatch(
      /statement/,
    );
    expect(invalidArg(() => validateCreate(req({ difficulty: Difficulty.UNSPECIFIED })))).toMatch(
      /difficulty/,
    );
    expect(invalidArg(() => validateCreate(req({ difficulty: 99 })))).toMatch(/difficulty/);
    expect(invalidArg(() => validateCreate(req({ timeLimitMs: 50 })))).toMatch(/time_limit_ms/);
    expect(invalidArg(() => validateCreate(req({ memoryLimitMb: 4096 })))).toMatch(
      /memory_limit_mb/,
    );
    expect(invalidArg(() => validateCreate(req({ slug: 'Mal' })))).toMatch(/slug/);
    const examples = Array.from({ length: 21 }, () => ({ input: '', output: '' }));
    expect(invalidArg(() => validateCreate(req({ examples })))).toMatch(/ejemplos/);
    expect(
      invalidArg(() => validateCreate(req({ examples: [{ input: 'x'.repeat(10_001) }] }))),
    ).toMatch(/examples\[0\]\.input/);
  });
});

describe('validateUpdate', () => {
  it('solo incluye los campos presentes', () => {
    expect(validateUpdate(create(UpdateProblemRequestSchema, { id: 'x' }))).toEqual({});
    const patch = validateUpdate(
      create(UpdateProblemRequestSchema, {
        id: 'x',
        title: 'T',
        statement: 'S',
        difficulty: Difficulty.HARD,
        timeLimitMs: 3000,
        memoryLimitMb: 64,
        tags: { values: [] },
        examples: { values: [{ input: 'a', output: 'b', explanation: 'c' }] },
        published: false,
      }),
    );
    expect(patch).toEqual({
      title: 'T',
      statement: 'S',
      difficulty: 'HARD',
      timeLimitMs: 3000,
      memoryLimitMb: 64,
      tags: [],
      examples: [{ input: 'a', output: 'b', explanation: 'c' }],
      published: false,
    });
  });

  it('un límite explícito en 0 es inválido', () => {
    expect(
      invalidArg(() =>
        validateUpdate(create(UpdateProblemRequestSchema, { id: 'x', timeLimitMs: 0 })),
      ),
    ).toMatch(/time_limit_ms/);
    expect(
      invalidArg(() =>
        validateUpdate(create(UpdateProblemRequestSchema, { id: 'x', memoryLimitMb: 0 })),
      ),
    ).toMatch(/memory_limit_mb/);
  });
});

describe('helpers', () => {
  it('tags', () => {
    expect(normalizeTags([' DP ', 'dp', 'Grafos'])).toEqual(['dp', 'grafos']);
    expect(invalidArg(() => normalizeTags(['']))).toMatch(/vacíos/);
    expect(invalidArg(() => normalizeTags(['x'.repeat(41)]))).toMatch(/40/);
    expect(invalidArg(() => normalizeTags(Array.from({ length: 21 }, (_, i) => `t${i}`)))).toMatch(
      /20/,
    );
  });

  it('dificultad', () => {
    expect(difficultyToDb(Difficulty.UNSPECIFIED)).toBeUndefined();
    expect(difficultyToDb(Difficulty.EASY)).toBe('EASY');
    expect(difficultyFromDb('HARD')).toBe(Difficulty.HARD);
  });

  it('uuid, ordinal y page_size', () => {
    expect(requireUuid('AAAAAAAA-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'id')).toBe(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    expect(invalidArg(() => requireUuid('x', 'problem_id'))).toMatch(/problem_id/);
    expect(validateOrdinal(1)).toBe(1);
    expect(invalidArg(() => validateOrdinal(1001))).toMatch(/ordinal/);
    expect(pageSize(0)).toBe(20);
    expect(pageSize(5)).toBe(5);
    expect(pageSize(1000)).toBe(100);
    expect(invalidArg(() => pageSize(-1))).toMatch(/page_size/);
  });

  it('page_token', () => {
    expect(decodePageToken('')).toBeUndefined();
    expect(decodePageToken(encodePageToken('42'))).toBe('42');
    expect(invalidArg(() => decodePageToken(Buffer.from('s:abc').toString('base64url')))).toMatch(
      /page_token/,
    );
  });
});
