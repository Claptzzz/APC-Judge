import { z } from 'zod';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_SOURCE_CODE_BYTES = 65536;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export const createSubmissionSchema = z.object({
  problemId: z.string().refine(isUuid, 'problem_id debe ser un UUID válido'),
  language: z.enum(['CPP17', 'PYTHON3']),
  sourceCode: z
    .string()
    .min(1, 'source_code no puede estar vacío')
    .max(
      MAX_SOURCE_CODE_BYTES,
      `source_code excede el tamaño máximo (${MAX_SOURCE_CODE_BYTES} bytes)`,
    ),
  contestId: z.string().refine(isUuid, 'contest_id debe ser un UUID válido').optional(),
});

export type CreateSubmissionInput = z.infer<typeof createSubmissionSchema>;
