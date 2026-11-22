import type { AddressInfo } from 'node:net';
import type { status as GrpcStatus } from '@grpc/grpc-js';
import { common, problems, ranking } from '@juez/contracts/nest';
import type { submissions, users } from '@juez/contracts/nest';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import type { CryptoKey } from 'jose';
import { pino } from 'pino';
import { vi } from 'vitest';
import type { Mock } from 'vitest';
import type { AppDeps } from '../app.module.js';
import { createApp } from '../app.js';
import { JwtVerifier } from '../auth/jwt-verifier.js';
import type { Role } from '../auth/jwt-verifier.js';
import { loadConfig } from '../config.js';
import type { Config } from '../config.js';
import type { JudgedEvent } from '../events/judged.js';
import { PubSub } from '../events/pubsub.js';
import type { Backend } from '../grpc/backend.js';
import { fromGrpcError } from '../grpc/errors.js';
import type { ServiceName } from '../grpc/errors.js';
import type { Logger } from '../logger.js';
import { createMetrics } from '../metrics.js';

export const silentLogger: Logger = pino({ level: 'silent' });

export const ALICE = {
  sub: '11111111-1111-4111-8111-111111111111',
  username: 'alice',
  role: 'CONTESTANT' as Role,
};
export const BOB = {
  sub: '22222222-2222-4222-8222-222222222222',
  username: 'bob',
  role: 'CONTESTANT' as Role,
};
export const ADMIN = {
  sub: '33333333-3333-4333-8333-333333333333',
  username: 'root',
  role: 'ADMIN' as Role,
};
export const SETTER = {
  sub: '44444444-4444-4444-8444-444444444444',
  username: 'setter',
  role: 'SETTER' as Role,
};
export const PROBLEM_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const PROBLEM_2_ID = 'abababab-abab-4bab-8bab-abababababab';
export const CONTEST_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const SUBMISSION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

export const ISSUER = 'juez-users';
export const AUDIENCE = 'juez';
export const KEY_ID = 'test-1';

export interface Keys {
  privateKey: CryptoKey;
  publicKeyPem: string;
}

export async function createKeys(): Promise<Keys> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  return { privateKey, publicKeyPem: await exportSPKI(publicKey) };
}

export function signToken(
  keys: Keys,
  claims: { sub: string; username: string; role: Role } = ALICE,
  opts: { kid?: string; expiresIn?: string | number; issuer?: string; audience?: string } = {},
): Promise<string> {
  return new SignJWT({ username: claims.username, role: claims.role })
    .setProtectedHeader({ alg: 'RS256', kid: opts.kid ?? KEY_ID })
    .setSubject(claims.sub)
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? '1h')
    .sign(keys.privateKey);
}

/** Error gRPC como lo entrega @grpc/grpc-js, ya traducido como lo haría la fachada. */
export function upstreamError(service: ServiceName, code: GrpcStatus, details = 'detalle') {
  return fromGrpcError(service, { code, details });
}

export const ts = (iso: string) => {
  const ms = Date.parse(iso);
  return { seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 };
};

export function sampleUser(
  claims: { sub: string; username: string; role: Role } = ALICE,
): users.User {
  return {
    id: claims.sub,
    username: claims.username,
    email: `${claims.username}@juez.test`,
    role: common.Role[`ROLE_${claims.role}`],
    createdAt: ts('2026-11-01T10:00:00.000Z'),
  };
}

export function sampleProblem(overrides: Partial<problems.Problem> = {}): problems.Problem {
  return {
    id: PROBLEM_ID,
    slug: 'suma',
    title: 'Suma',
    statement: 'Suma dos números',
    difficulty: problems.Difficulty.DIFFICULTY_EASY,
    tags: ['math'],
    timeLimitMs: 1000,
    memoryLimitMb: 256,
    examples: [{ input: '1 2', output: '3', explanation: '' }],
    testcaseCount: 3,
    published: true,
    authorId: SETTER.sub,
    createdAt: ts('2026-11-01T10:00:00.000Z'),
    updatedAt: ts('2026-11-02T10:00:00.000Z'),
    ...overrides,
  };
}

export function sampleSubmission(
  overrides: Partial<submissions.Submission> = {},
): submissions.Submission {
  return {
    id: SUBMISSION_ID,
    userId: ALICE.sub,
    problemId: PROBLEM_ID,
    contestId: undefined,
    language: common.Language.LANGUAGE_CPP17,
    sourceCode: 'int main(){}',
    verdict: common.Verdict.VERDICT_PENDING,
    timeMs: 0,
    memoryKb: 0,
    passedCases: 0,
    totalCases: 0,
    submittedAt: ts('2026-11-22T15:00:00.000Z'),
    judgedAt: undefined,
    ...overrides,
  };
}

export function sampleContest(overrides: Partial<ranking.Contest> = {}): ranking.Contest {
  return {
    id: CONTEST_ID,
    title: 'Contest 1',
    description: 'desc',
    startTime: ts('2026-11-22T14:00:00.000Z'),
    endTime: ts('2026-11-22T19:00:00.000Z'),
    problemIds: [PROBLEM_ID, PROBLEM_2_ID],
    status: ranking.ContestStatus.CONTEST_STATUS_RUNNING,
    createdBy: SETTER.sub,
    createdAt: ts('2026-11-20T10:00:00.000Z'),
    ...overrides,
  };
}

export function sampleJudged(overrides: Partial<JudgedEvent> = {}): JudgedEvent {
  return {
    eventId: 'evt-1',
    submissionId: SUBMISSION_ID,
    userId: ALICE.sub,
    problemId: PROBLEM_ID,
    contestId: null,
    verdict: 'WRONG_ANSWER',
    timeMs: 12,
    memoryKb: 3400,
    passedCases: 1,
    totalCases: 3,
    submittedAt: '2026-11-22T15:00:00.000Z',
    judgedAt: '2026-11-22T15:00:05.000Z',
    ...overrides,
  };
}

type MockedService<T> = { [K in keyof T]: Mock<Extract<T[K], (...args: never[]) => unknown>> };
export type FakeBackend = { [S in keyof Backend]: MockedService<Backend[S]> };

/** Backend con todos los métodos mockeados (valores por defecto razonables). */
export function fakeBackend(keys: Keys): FakeBackend {
  return {
    users: {
      register: vi.fn(async (req) => ({
        user: { ...sampleUser(), username: req.username, email: req.email },
      })),
      login: vi.fn(async () => ({
        accessToken: 'jwt-de-login',
        tokenType: 'Bearer',
        expiresAt: ts('2026-11-22T16:00:00.000Z'),
        user: sampleUser(),
      })),
      getUser: vi.fn(async (req) => ({ user: { ...sampleUser(), id: req.id } })),
      getUsers: vi.fn(async (req: { ids: string[] }) => ({
        users: req.ids.map((id) => ({ ...sampleUser(), id, username: `u-${id.slice(0, 4)}` })),
      })),
      getPublicKey: vi.fn(async () => ({
        publicKeyPem: keys.publicKeyPem,
        keyId: KEY_ID,
        algorithm: 'RS256',
        issuer: ISSUER,
        audience: AUDIENCE,
      })),
    } as unknown as FakeBackend['users'],
    problems: {
      listProblems: vi.fn(async () => ({ problems: [sampleProblem()], nextPageToken: '' })),
      getProblem: vi.fn(async (req) => ({
        problem: sampleProblem(req.id ? { id: req.id } : { slug: req.slug ?? '' }),
      })),
      createProblem: vi.fn(async () => ({ problem: sampleProblem({ published: false }) })),
      updateProblem: vi.fn(async () => ({ problem: sampleProblem() })),
      createTestcaseUploadUrl: vi.fn(async () => ({
        testcaseId: 'tc-1',
        inputUploadUrl: 'http://minio/in',
        outputUploadUrl: 'http://minio/out',
        expiresAt: ts('2026-11-22T15:15:00.000Z'),
      })),
      getJudgeSpec: vi.fn(),
    } as unknown as FakeBackend['problems'],
    submissions: {
      createSubmission: vi.fn(async () => ({ submission: sampleSubmission() })),
      getSubmission: vi.fn(async () => ({ submission: sampleSubmission() })),
      listSubmissions: vi.fn(async () => ({
        submissions: [sampleSubmission({ sourceCode: '' })],
        nextPageToken: '',
      })),
    } as unknown as FakeBackend['submissions'],
    ranking: {
      createContest: vi.fn(async () => ({ contest: sampleContest() })),
      getContest: vi.fn(async () => ({ contest: sampleContest() })),
      listContests: vi.fn(async () => ({ contests: [sampleContest()], nextPageToken: 'next' })),
      getScoreboard: vi.fn(async () => ({
        contestId: CONTEST_ID,
        rows: [],
        nextPageToken: '',
        updatedAt: undefined,
      })),
      getUserStats: vi.fn(async () => ({
        userId: ALICE.sub,
        username: 'alice',
        solvedCount: 0,
        attemptedCount: 0,
        totalSubmissions: 0,
        verdictCounts: [],
        solvedProblemIds: [],
      })),
    } as unknown as FakeBackend['ranking'],
  };
}

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig(
    { NODE_ENV: 'test', KAFKA_BROKERS: 'localhost:1', LOG_LEVEL: 'silent', ...env },
    'test-host',
  );
}

export interface FakeConsumer {
  readiness: { status: Mock<() => { joined: boolean; crashed: boolean; ready: boolean }> };
  start: Mock<() => Promise<void>>;
  stop: Mock<() => Promise<void>>;
}

export function fakeConsumer(ready = true): FakeConsumer {
  return {
    readiness: { status: vi.fn(() => ({ joined: ready, crashed: false, ready })) },
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
}

export interface TestApp {
  url: string;
  wsUrl: string;
  backend: FakeBackend;
  pubsub: PubSub<JudgedEvent>;
  verifier: JwtVerifier;
  consumer: FakeConsumer;
  assistant: { ask: Mock<AppDeps['assistant']['ask']> };
  close(): Promise<void>;
  gql<T = Record<string, unknown>>(
    query: string,
    variables?: Record<string, unknown>,
    opts?: { token?: string; headers?: Record<string, string> },
  ): Promise<{ status: number; data?: T | null; errors?: GqlTestError[] }>;
}

export interface GqlTestError {
  message: string;
  path?: Array<string | number>;
  extensions?: { code?: string; [k: string]: unknown };
}

export async function startTestApp(
  keys: Keys,
  overrides: Partial<Pick<AppDeps, 'assistant'>> & {
    env?: Record<string, string>;
    consumer?: FakeConsumer;
    backend?: FakeBackend;
  } = {},
): Promise<TestApp> {
  const config = testConfig(overrides.env);
  const backend = overrides.backend ?? fakeBackend(keys);
  const verifier = new JwtVerifier(
    backend.users as Backend['users'],
    ISSUER,
    AUDIENCE,
    silentLogger,
  );
  const pubsub = new PubSub<JudgedEvent>();
  const consumer = overrides.consumer ?? fakeConsumer();
  const assistant = (overrides.assistant ?? {
    ask: vi.fn(async () => ({ message: 'hola', toolCalls: [] })),
  }) as TestApp['assistant'];
  const app = await createApp({
    config,
    logger: silentLogger,
    metrics: createMetrics({ defaultMetrics: false }),
    backend: backend as unknown as Backend,
    verifier,
    pubsub,
    assistant,
    consumer,
  });
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    wsUrl: `ws://127.0.0.1:${port}/graphql`,
    backend,
    pubsub,
    verifier,
    consumer,
    assistant,
    close: () => app.close(),
    async gql(query, variables, opts = {}) {
      const res = await fetch(`${url}/graphql`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
          ...opts.headers,
        },
        body: JSON.stringify({ query, variables }),
      });
      const body = (await res.json()) as { data?: never; errors?: GqlTestError[] };
      return { status: res.status, ...body };
    },
  };
}
