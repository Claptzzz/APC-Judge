import type { Session } from '../lib/session';

export const FUTURE = '2999-01-01T00:00:00.000Z';

export function makeSession(
  role: Session['user']['role'] = 'CONTESTANT',
  overrides: Partial<Session['user']> = {},
): Session {
  return {
    token: `token-${role.toLowerCase()}`,
    expiresAt: FUTURE,
    user: {
      id: `u-${role.toLowerCase()}`,
      username: role.toLowerCase(),
      email: `${role.toLowerCase()}@x.cl`,
      role,
      ...overrides,
    },
  };
}

export const userFixture = (session: Session) => ({
  __typename: 'User' as const,
  id: session.user.id,
  username: session.user.username,
  email: session.user.email ?? null,
  role: session.user.role,
  createdAt: '2026-01-01T00:00:00.000Z',
});

export const problemSummary = (n: number, overrides: Record<string, unknown> = {}) => ({
  __typename: 'ProblemSummary' as const,
  id: `p${n}`,
  slug: `problema-${n}`,
  title: `Problema ${n}`,
  difficulty: 'EASY' as const,
  tags: ['math'],
  published: true,
  ...overrides,
});

export const problemFixture = (overrides: Record<string, unknown> = {}) => ({
  __typename: 'Problem' as const,
  id: 'p1',
  slug: 'suma',
  title: 'Suma de dos números',
  statement: 'Dados **a** y **b**, imprime `a + b`.\n\n<script>alert(1)</script>',
  difficulty: 'EASY' as const,
  tags: ['math'],
  timeLimitMs: 1000,
  memoryLimitMb: 256,
  examples: [
    { __typename: 'Example' as const, input: '1 2', output: '3', explanation: 'Porque 1 + 2 = 3.' },
  ],
  testcaseCount: 2,
  published: true,
  authorId: 'u-setter',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

export const submissionFixture = (overrides: Record<string, unknown> = {}) => ({
  __typename: 'Submission' as const,
  id: 's1-abcdef123',
  verdict: 'PENDING' as const,
  timeMs: null,
  memoryKb: null,
  passedCases: null,
  totalCases: null,
  judgedAt: null,
  userId: 'u-contestant',
  user: { __typename: 'User' as const, id: 'u-contestant', username: 'contestant' },
  problemId: 'p1',
  problem: {
    __typename: 'ProblemSummary' as const,
    id: 'p1',
    slug: 'suma',
    title: 'Suma de dos números',
  },
  contestId: null,
  contest: null,
  language: 'CPP17' as const,
  sourceCode: 'int main() {}',
  submittedAt: '2026-11-22T15:00:00.000Z',
  ...overrides,
});

export const contestFixture = (overrides: Record<string, unknown> = {}) => ({
  __typename: 'Contest' as const,
  id: 'c1',
  title: 'Copa UCN',
  description: 'Contest de **prueba**',
  startTime: '2026-11-22T14:00:00.000Z',
  endTime: '2999-11-22T19:00:00.000Z',
  status: 'RUNNING' as const,
  createdById: 'u-setter',
  problems: [
    {
      __typename: 'ContestProblem' as const,
      letter: 'A',
      problemId: 'p1',
      problem: {
        __typename: 'ProblemSummary' as const,
        id: 'p1',
        slug: 'suma',
        title: 'Suma',
        difficulty: 'EASY' as const,
      },
    },
    {
      __typename: 'ContestProblem' as const,
      letter: 'B',
      problemId: 'p2',
      problem: null,
    },
  ],
  ...overrides,
});
