import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { SubmissionJudgedSchema, UserRegisteredSchema, Verdict } from '@juez/contracts/es';
import type { SubmissionJudged, UserRegistered } from '@juez/contracts/es';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import type { CryptoKey } from 'jose';
import { JwtVerifier } from '../src/auth/jwt.js';
import type { Role } from '../src/auth/jwt.js';
import { contestStatus } from '../src/domain/contest.js';
import type { Contest, JudgedSubmission } from '../src/domain/types.js';
import { createLogger } from '../src/logger.js';
import type { Logger } from '../src/logger.js';
import type { RedisCommand, RedisLike } from '../src/projection/redis.js';
import type {
  ListContestsQuery,
  NewContest,
  RankingRepository,
  SubmissionFilter,
  SubmissionJudgedData,
  UserRegisteredData,
  UserStatsData,
} from '../src/repository.js';

export const silentLogger = createLogger('silent');

/** Logger que acumula las líneas JSON en memoria. */
export function memoryLogger(level = 'trace'): {
  logger: Logger;
  lines: () => Record<string, unknown>[];
} {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  return {
    logger: createLogger(level, stream),
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

/** UUID determinista legible: uuid(1) -> 00000000-0000-4000-8000-000000000001 */
export function uuid(n: number, prefix = '0'): string {
  return `${prefix.repeat(8)}-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

export const T0 = new Date('2026-11-20T10:00:00.000Z');
export const minutes = (m: number, base = T0) => new Date(base.getTime() + m * 60_000);

export function makeContest(overrides: Partial<Contest> = {}): Contest {
  return {
    id: uuid(1, 'c'),
    title: 'Contest',
    description: '',
    startTime: T0,
    endTime: minutes(300),
    problemIds: [uuid(1, 'a'), uuid(2, 'a'), uuid(3, 'a')],
    createdBy: uuid(99),
    createdAt: minutes(-60),
    ...overrides,
  };
}

let seq = 0;
export function sub(
  partial: Partial<JudgedSubmission> & Pick<JudgedSubmission, 'verdict' | 'submittedAt'>,
): JudgedSubmission {
  seq++;
  return {
    submissionId: uuid(seq, 'f'),
    userId: uuid(1),
    problemId: uuid(1, 'a'),
    contestId: uuid(1, 'c'),
    ...partial,
  };
}

// ---------------------------------------------------------------------------- eventos

export function judgedEvent(
  init: {
    submissionId?: string;
    userId?: string;
    problemId?: string;
    contestId?: string;
    verdict?: Verdict;
    submittedAt?: Date;
    eventId?: string;
    occurredAt?: Date;
  } = {},
): SubmissionJudged {
  return create(SubmissionJudgedSchema, {
    eventId: init.eventId ?? randomUUID(),
    occurredAt: timestampFromDate(init.occurredAt ?? minutes(400)),
    submissionId: init.submissionId ?? randomUUID(),
    userId: init.userId ?? uuid(1),
    problemId: init.problemId ?? uuid(1, 'a'),
    contestId: init.contestId,
    verdict: init.verdict ?? Verdict.ACCEPTED,
    submittedAt: init.submittedAt ? timestampFromDate(init.submittedAt) : undefined,
  });
}

export function registeredEvent(userId: string, username: string, eventId: string = randomUUID()) {
  return create(UserRegisteredSchema, {
    eventId,
    occurredAt: timestampFromDate(T0),
    userId,
    username,
  }) as UserRegistered;
}

// ---------------------------------------------------------------------------- repositorio

interface StoredSubmission extends JudgedSubmission {
  judgedAt: Date;
  eventId: string;
}

/** Repositorio en memoria con la misma semántica que Postgres (dedupe, upsert, ventanas). */
export class InMemoryRankingRepository implements RankingRepository {
  readonly contests = new Map<string, Contest>();
  readonly submissions = new Map<string, StoredSubmission>();
  readonly names = new Map<string, string>();
  readonly processed = new Set<string>();
  /** Errores a lanzar en las próximas llamadas a apply*. */
  applyFailures: Error[] = [];
  /** Si está definido, las lecturas fallan (BD caída después del commit). */
  readFailure: Error | undefined;
  private contestSeq = 0;

  private nextApplyFailure() {
    const err = this.applyFailures.shift();
    if (err) throw err;
  }

  private read() {
    if (this.readFailure) throw this.readFailure;
  }

  async applyUserRegistered(d: UserRegisteredData): Promise<boolean> {
    this.nextApplyFailure();
    if (this.processed.has(d.eventId)) return false;
    this.processed.add(d.eventId);
    this.names.set(d.userId, d.username);
    return true;
  }

  async applySubmissionJudged(d: SubmissionJudgedData): Promise<boolean> {
    this.nextApplyFailure();
    if (this.processed.has(d.eventId)) return false;
    this.processed.add(d.eventId);
    const prev = this.submissions.get(d.submissionId);
    if (prev && prev.judgedAt > d.judgedAt) return true;
    this.submissions.set(d.submissionId, {
      submissionId: d.submissionId,
      userId: prev?.userId ?? d.userId,
      problemId: prev?.problemId ?? d.problemId,
      contestId: prev ? prev.contestId : d.contestId,
      submittedAt: prev?.submittedAt ?? d.submittedAt,
      verdict: d.verdict,
      judgedAt: d.judgedAt,
      eventId: d.eventId,
    });
    return true;
  }

  async createContest(input: NewContest): Promise<Contest> {
    const contest: Contest = {
      ...input,
      problemIds: [...input.problemIds],
      id: uuid(++this.contestSeq, 'e'),
      createdAt: T0,
    };
    this.contests.set(contest.id, contest);
    return contest;
  }

  addContest(contest: Contest): Contest {
    this.contests.set(contest.id, contest);
    return contest;
  }

  async findContest(id: string) {
    this.read();
    return this.contests.get(id);
  }

  async listContests(q: ListContestsQuery): Promise<Contest[]> {
    return [...this.contests.values()]
      .filter((c) => !q.status || contestStatus(c, q.now) === q.status)
      .sort((a, b) => b.startTime.getTime() - a.startTime.getTime() || (a.id < b.id ? 1 : -1))
      .filter(
        (c) =>
          !q.after ||
          c.startTime < q.after.startTime ||
          (c.startTime.getTime() === q.after.startTime.getTime() && c.id < q.after.id),
      )
      .slice(0, q.limit);
  }

  async listContestIds() {
    this.read();
    return [...this.contests.keys()];
  }

  async contestsOfUser(userId: string) {
    this.read();
    const ids = new Set<string>();
    for (const s of this.submissions.values()) {
      if (s.userId === userId && s.contestId && this.contests.has(s.contestId))
        ids.add(s.contestId);
    }
    return [...ids];
  }

  async contestSubmissions(contest: Contest, filter: SubmissionFilter = {}) {
    this.read();
    return [...this.submissions.values()]
      .filter(
        (s) =>
          s.contestId === contest.id &&
          s.submittedAt >= contest.startTime &&
          s.submittedAt < contest.endTime &&
          (!filter.userId || s.userId === filter.userId) &&
          (!filter.acceptedOnly || s.verdict === 'ACCEPTED'),
      )
      .map(({ judgedAt: _j, eventId: _e, ...s }) => s);
  }

  async usernames(userIds: readonly string[]) {
    this.read();
    return new Map(
      userIds.flatMap((id) => (this.names.has(id) ? [[id, this.names.get(id)!]] : [])),
    );
  }

  async userStats(userId: string): Promise<UserStatsData> {
    this.read();
    const mine = [...this.submissions.values()].filter((s) => s.userId === userId);
    const counts = new Map<string, number>();
    for (const s of mine) counts.set(s.verdict, (counts.get(s.verdict) ?? 0) + 1);
    const problems = new Map<string, boolean>();
    for (const s of mine)
      problems.set(s.problemId, problems.get(s.problemId) || s.verdict === 'ACCEPTED');
    return {
      username: this.names.get(userId),
      totalSubmissions: mine.length,
      verdictCounts: [...counts].map(([verdict, count]) => ({
        verdict: verdict as JudgedSubmission['verdict'],
        count,
      })),
      solvedProblemIds: [...problems]
        .filter(([, ok]) => ok)
        .map(([p]) => p)
        .sort(),
      attemptedCount: problems.size,
    };
  }
}

// ---------------------------------------------------------------------------- redis

type Value =
  { kind: 'zset'; data: Map<string, number> } | { kind: 'hash'; data: Map<string, string> };

/** Redis en memoria con los comandos que usa la proyección. `down = true` simula una caída. */
export class FakeRedis implements RedisLike {
  readonly keys = new Map<string, Value>();
  down = false;
  transactions = 0;

  private check() {
    if (this.down) throw new Error('redis no disponible');
  }

  private zset(key: string, create = false) {
    const v = this.keys.get(key);
    if (v?.kind === 'zset') return v.data;
    if (!create) return new Map<string, number>();
    const data = new Map<string, number>();
    this.keys.set(key, { kind: 'zset', data });
    return data;
  }

  private hash(key: string, create = false) {
    const v = this.keys.get(key);
    if (v?.kind === 'hash') return v.data;
    if (!create) return new Map<string, string>();
    const data = new Map<string, string>();
    this.keys.set(key, { kind: 'hash', data });
    return data;
  }

  private cleanup(key: string) {
    const v = this.keys.get(key);
    if (v && v.data.size === 0) this.keys.delete(key);
  }

  async exists(key: string) {
    this.check();
    return this.keys.has(key) ? 1 : 0;
  }

  async zcard(key: string) {
    this.check();
    return this.zset(key).size;
  }

  private sorted(key: string) {
    return [...this.zset(key)].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1));
  }

  async zrevrangeWithScores(key: string, start: number, stop: number) {
    this.check();
    return this.sorted(key)
      .slice(start, stop + 1)
      .flatMap(([m, s]) => [m, String(s)]);
  }

  async zcount(key: string, min: string, max: string) {
    this.check();
    const lo = min.startsWith('(')
      ? { v: Number(min.slice(1)), excl: true }
      : { v: Number(min), excl: false };
    if (max !== '+inf') throw new Error('fake: solo max=+inf');
    return [...this.zset(key).values()].filter((s) => (lo.excl ? s > lo.v : s >= lo.v)).length;
  }

  async hmget(key: string, fields: string[]) {
    this.check();
    const h = this.hash(key);
    return fields.map((f) => h.get(f) ?? null);
  }

  async hgetall(key: string) {
    this.check();
    return Object.fromEntries(this.hash(key));
  }

  async hget(key: string, field: string) {
    this.check();
    return this.hash(key).get(field) ?? null;
  }

  async ping() {
    this.check();
    return 'PONG';
  }

  async transaction(commands: RedisCommand[]) {
    this.check();
    this.transactions++;
    for (const [name, ...args] of commands) {
      const [key, ...rest] = args.map(String) as [string, ...string[]];
      switch (name) {
        case 'del':
          for (const k of [key, ...rest]) this.keys.delete(k);
          break;
        case 'zadd': {
          const z = this.zset(key, true);
          for (let i = 0; i < rest.length; i += 2) z.set(rest[i + 1]!, Number(rest[i]));
          break;
        }
        case 'zrem':
          for (const m of rest) this.zset(key).delete(m);
          this.cleanup(key);
          break;
        case 'hset': {
          const h = this.hash(key, true);
          for (let i = 0; i < rest.length; i += 2) h.set(rest[i]!, rest[i + 1]!);
          break;
        }
        case 'hdel':
          for (const f of rest) this.hash(key).delete(f);
          this.cleanup(key);
          break;
        default:
          throw new Error(`fake: comando no soportado ${name}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------- jwt

export interface TestJwt {
  verifier: JwtVerifier;
  sign(
    claims?: { sub?: string; role?: Role | string; username?: string },
    opts?: { expiresIn?: string; issuer?: string; kid?: string },
  ): Promise<string>;
  publicKeyPem: string;
  privateKey: CryptoKey;
}

let keyPair: Promise<{ privateKey: CryptoKey; publicKeyPem: string }> | undefined;

export function rsaKeys() {
  keyPair ??= (async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
    return { privateKey, publicKeyPem: await exportSPKI(publicKey) };
  })();
  return keyPair;
}

export async function signToken(
  privateKey: CryptoKey,
  claims: { sub?: string; role?: Role | string; username?: string } = {},
  opts: { expiresIn?: string; issuer?: string; kid?: string } = {},
) {
  return new SignJWT({ username: claims.username ?? 'alice', role: claims.role ?? 'CONTESTANT' })
    .setProtectedHeader({ alg: 'RS256', kid: opts.kid ?? 'test-1' })
    .setSubject(claims.sub ?? uuid(1))
    .setIssuer(opts.issuer ?? 'juez-users')
    .setAudience('juez')
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? '1h')
    .sign(privateKey);
}

export async function testJwt(): Promise<TestJwt> {
  const { privateKey, publicKeyPem } = await rsaKeys();
  const verifier = new JwtVerifier(
    async () => ({ publicKeyPem, keyId: 'test-1', algorithm: 'RS256' }),
    { issuer: 'juez-users', audience: 'juez' },
  );
  return {
    verifier,
    publicKeyPem,
    privateKey,
    sign: (claims, opts) => signToken(privateKey, claims, opts),
  };
}
