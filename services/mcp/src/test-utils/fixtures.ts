import { create } from '@bufbuild/protobuf';
import type { MessageInitShape } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import {
  Difficulty,
  GetProblemResponseSchema,
  GetScoreboardResponseSchema,
  GetSubmissionResponseSchema,
  Language,
  ListProblemsResponseSchema,
  ListSubmissionsResponseSchema,
  ProblemSchema,
  SubmissionSchema,
  Verdict,
} from '@juez/contracts/es';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import type { CryptoKey } from 'jose';
import { vi } from 'vitest';
import type { Mock } from 'vitest';
import { JwtVerifier } from '../auth/jwt.js';
import { createLogger } from '../logger.js';
import type { UpstreamClients } from '../upstream/clients.js';

export const ISSUER = 'juez-users';
export const AUDIENCE = 'juez';
export const silentLogger = createLogger('silent');

export const ALICE = {
  sub: '11111111-1111-4111-8111-111111111111',
  username: 'alice',
  role: 'CONTESTANT',
} as const;
export const BOB_ID = '22222222-2222-4222-8222-222222222222';
export const PROBLEM_ID = '33333333-3333-4333-8333-333333333333';
export const SUBMISSION_ID = '44444444-4444-4444-8444-444444444444';
export const CONTEST_ID = '55555555-5555-4555-8555-555555555555';
export const PROBLEM_2_ID = '66666666-6666-4666-8666-666666666666';

export interface Keys {
  privateKey: CryptoKey;
  publicKeyPem: string;
}

export async function createKeys(): Promise<Keys> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  return { privateKey, publicKeyPem: await exportSPKI(publicKey) };
}

export async function signToken(
  keys: Keys,
  overrides: {
    sub?: string;
    username?: string;
    role?: string;
    issuer?: string;
    audience?: string;
    expiresIn?: string;
  } = {},
): Promise<string> {
  return new SignJWT({
    username: overrides.username ?? ALICE.username,
    role: overrides.role ?? ALICE.role,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'dev-1' })
    .setSubject(overrides.sub ?? ALICE.sub)
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(overrides.expiresIn ?? '1h')
    .sign(keys.privateKey);
}

/** Verifier con un users falso que entrega la llave pública de `keys`. */
export async function readyVerifier(keys: Keys): Promise<JwtVerifier> {
  const verifier = new JwtVerifier(
    {
      getPublicKey: vi.fn().mockResolvedValue({
        publicKeyPem: keys.publicKeyPem,
        algorithm: 'RS256',
        keyId: 'dev-1',
      }),
    } as never,
    { issuer: ISSUER, audience: AUDIENCE, logger: silentLogger },
  );
  await verifier.init();
  return verifier;
}

const at = (iso: string) => timestampFromDate(new Date(iso));

export const sampleProblem = (statement = 'Dados dos enteros a y b, imprime a + b.') =>
  create(ProblemSchema, {
    id: PROBLEM_ID,
    slug: 'suma',
    title: 'Suma de dos números',
    statement,
    difficulty: Difficulty.EASY,
    tags: ['matematicas', 'implementacion'],
    timeLimitMs: 1000,
    memoryLimitMb: 256,
    examples: [{ input: '1 2', output: '3', explanation: '1 + 2 = 3' }],
    testcaseCount: 10,
    published: true,
  });

export const sampleSubmission = (
  overrides: Omit<MessageInitShape<typeof SubmissionSchema>, '$typeName'> = {},
) =>
  create(SubmissionSchema, {
    id: SUBMISSION_ID,
    userId: ALICE.sub,
    problemId: PROBLEM_ID,
    language: Language.CPP17,
    sourceCode: '#include <cstdio>\nint main(){int a,b;scanf("%d %d",&a,&b);printf("%d",a-b);}',
    verdict: Verdict.WRONG_ANSWER,
    timeMs: 12,
    memoryKb: 3_400,
    passedCases: 3,
    totalCases: 10,
    submittedAt: at('2026-11-20T14:05:00Z'),
    judgedAt: at('2026-11-20T14:05:03Z'),
    ...overrides,
  });

type P = UpstreamClients['problems'];
type S = UpstreamClients['submissions'];
type R = UpstreamClients['ranking'];

/** Clientes Connect falsos: mocks tipados con las firmas reales de los clientes Connect. */
export interface FakeClients {
  problems: { listProblems: Mock<P['listProblems']>; getProblem: Mock<P['getProblem']> };
  submissions: {
    listSubmissions: Mock<S['listSubmissions']>;
    getSubmission: Mock<S['getSubmission']>;
  };
  ranking: { getScoreboard: Mock<R['getScoreboard']> };
}

/** Clientes Connect falsos (vi.fn) con respuestas de ejemplo. */
export function fakeClients(): FakeClients {
  return {
    problems: {
      listProblems: vi.fn<P['listProblems']>().mockResolvedValue(
        create(ListProblemsResponseSchema, {
          problems: [
            {
              id: PROBLEM_ID,
              slug: 'suma',
              title: 'Suma de dos números',
              difficulty: Difficulty.EASY,
              tags: ['matematicas'],
              published: true,
            },
          ],
          nextPageToken: 'pagina-2',
        }),
      ),
      getProblem: vi
        .fn<P['getProblem']>()
        .mockResolvedValue(create(GetProblemResponseSchema, { problem: sampleProblem() })),
    },
    submissions: {
      listSubmissions: vi.fn<S['listSubmissions']>().mockResolvedValue(
        create(ListSubmissionsResponseSchema, {
          submissions: [sampleSubmission({ sourceCode: '' })],
          nextPageToken: '',
        }),
      ),
      getSubmission: vi
        .fn<S['getSubmission']>()
        .mockResolvedValue(create(GetSubmissionResponseSchema, { submission: sampleSubmission() })),
    },
    ranking: {
      getScoreboard: vi.fn<R['getScoreboard']>().mockResolvedValue(
        create(GetScoreboardResponseSchema, {
          contestId: CONTEST_ID,
          updatedAt: at('2026-11-20T15:00:00Z'),
          rows: [
            {
              rank: 1,
              userId: BOB_ID,
              username: 'bob',
              solved: 2,
              penaltyMinutes: 75,
              problems: [
                {
                  problemId: PROBLEM_ID,
                  solved: true,
                  attempts: 1,
                  solvedAtMinute: 20,
                  firstToSolve: true,
                },
                {
                  problemId: PROBLEM_2_ID,
                  solved: true,
                  attempts: 2,
                  solvedAtMinute: 35,
                  penaltyMinutes: 20,
                },
              ],
            },
            {
              rank: 2,
              userId: ALICE.sub,
              username: 'alice',
              solved: 1,
              penaltyMinutes: 40,
              problems: [
                { problemId: PROBLEM_ID, solved: true, attempts: 1, solvedAtMinute: 40 },
                { problemId: PROBLEM_2_ID, solved: false, attempts: 3 },
              ],
            },
          ],
        }),
      ),
    },
  };
}
