import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { create } from '@bufbuild/protobuf';
import { GetJudgeSpecResponseSchema, SubmissionCreatedSchema, Language } from '@juez/contracts/es';
import type { GetJudgeSpecResponse, SubmissionCreated } from '@juez/contracts/es';
import { pino } from 'pino';
import type { DownloadedCase } from '../testcases.js';

export const silentLogger = pino({ level: 'silent' });

export interface FakeCase {
  input: string;
  output: string;
}

export function makeSpec(
  cases: FakeCase[],
  limits: { timeLimitMs?: number; memoryLimitMb?: number } = {},
): GetJudgeSpecResponse {
  return create(GetJudgeSpecResponseSchema, {
    problemId: 'p-1',
    timeLimitMs: limits.timeLimitMs ?? 2_000,
    memoryLimitMb: limits.memoryLimitMb ?? 256,
    testcases: cases.map((_, i) => ({
      id: `tc-${i + 1}`,
      ordinal: i + 1,
      inputUrl: `mem://${i}/in`,
      outputUrl: `mem://${i}/out`,
    })),
  });
}

/** "Descarga" los casos desde memoria, igual que downloadTestcases pero sin red. */
export function memoryDownloader(cases: FakeCase[]) {
  return async (spec: GetJudgeSpecResponse, dir: string): Promise<DownloadedCase[]> => {
    await mkdir(dir, { recursive: true });
    return Promise.all(
      spec.testcases.map(async (tc, i) => {
        const inputPath = join(dir, `${i}.in`);
        const outputPath = join(dir, `${i}.out`);
        await writeFile(inputPath, cases[i]!.input);
        await writeFile(outputPath, cases[i]!.output);
        return { id: tc.id, ordinal: tc.ordinal, inputPath, outputPath };
      }),
    );
  };
}

export function makeSubmission(
  overrides: Partial<Omit<SubmissionCreated, '$typeName' | '$unknown'>> = {},
): SubmissionCreated {
  return create(SubmissionCreatedSchema, {
    eventId: '11111111-1111-4111-8111-111111111111',
    occurredAt: { seconds: 1_700_000_000n, nanos: 0 },
    submissionId: '22222222-2222-4222-8222-222222222222',
    userId: 'u-1',
    problemId: 'p-1',
    language: Language.CPP17,
    sourceCode: '',
    ...overrides,
  });
}
