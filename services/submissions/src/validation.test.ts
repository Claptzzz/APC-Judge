import { describe, expect, it } from 'vitest';
import { createSubmissionSchema, isUuid, MAX_SOURCE_CODE_BYTES } from './validation.js';

describe('validation', () => {
  describe('isUuid', () => {
    it('reconoce UUIDs v4 válidos', () => {
      expect(isUuid('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11')).toBe(true);
      expect(isUuid('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    });

    it('rechaza strings que no son UUID', () => {
      expect(isUuid('')).toBe(false);
      expect(isUuid('not-a-uuid')).toBe(false);
      expect(isUuid('12345')).toBe(false);
      expect(isUuid('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11-extra')).toBe(false);
    });
  });

  describe('createSubmissionSchema', () => {
    it('valida input correcto', () => {
      const input = {
        problemId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        language: 'CPP17',
        sourceCode: '#include <iostream>\nint main() { return 0; }',
      };
      const res = createSubmissionSchema.safeParse(input);
      expect(res.success).toBe(true);
    });

    it('acepta contestId opcional', () => {
      const input = {
        problemId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        contestId: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
        language: 'PYTHON3',
        sourceCode: 'print(42)',
      };
      const res = createSubmissionSchema.safeParse(input);
      expect(res.success).toBe(true);
    });

    it('rechaza problemId inválido', () => {
      const input = {
        problemId: 'invalid',
        language: 'CPP17',
        sourceCode: 'print(1)',
      };
      const res = createSubmissionSchema.safeParse(input);
      expect(res.success).toBe(false);
    });

    it('rechaza contestId inválido si viene presente', () => {
      const input = {
        problemId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        contestId: 'invalid-contest',
        language: 'CPP17',
        sourceCode: 'print(1)',
      };
      const res = createSubmissionSchema.safeParse(input);
      expect(res.success).toBe(false);
    });

    it('rechaza lenguaje no soportado', () => {
      const input = {
        problemId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        language: 'JAVA',
        sourceCode: 'class Main {}',
      };
      const res = createSubmissionSchema.safeParse(input);
      expect(res.success).toBe(false);
    });

    it('rechaza sourceCode vacío', () => {
      const input = {
        problemId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        language: 'CPP17',
        sourceCode: '',
      };
      const res = createSubmissionSchema.safeParse(input);
      expect(res.success).toBe(false);
    });

    it('rechaza sourceCode que excede MAX_SOURCE_CODE_BYTES', () => {
      const input = {
        problemId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        language: 'CPP17',
        sourceCode: 'a'.repeat(MAX_SOURCE_CODE_BYTES + 1),
      };
      const res = createSubmissionSchema.safeParse(input);
      expect(res.success).toBe(false);
    });
  });
});
