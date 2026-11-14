import { encodeEvent, Topics } from '@juez/contracts';
import { Language, Verdict } from '@juez/contracts/es';
import { and, desc, eq, lt, or } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { outbox, processedEvents, submissions } from './db/schema.js';
import type { LanguageName, SubmissionRow, VerdictName } from './db/schema.js';

export interface NewSubmission {
  userId: string;
  problemId: string;
  contestId?: string;
  language: LanguageName;
  sourceCode: string;
}

export interface ListSubmissionsParams {
  pageSize: number;
  pageToken?: string;
  userId?: string;
  problemId?: string;
  contestId?: string;
}

export interface ListSubmissionsResult {
  submissions: SubmissionRow[];
  nextPageToken?: string;
}

export interface SubmissionJudgedEvent {
  eventId: string;
  submissionId: string;
  verdict: VerdictName;
  timeMs: number;
  memoryKb: number;
  passedCases: number;
  totalCases: number;
}

export const LANGUAGE_NAME_TO_PROTO: Record<LanguageName, Language> = {
  CPP17: Language.CPP17,
  PYTHON3: Language.PYTHON3,
};

export const PROTO_TO_LANGUAGE_NAME: Partial<Record<Language | number, LanguageName>> = {
  [Language.CPP17]: 'CPP17',
  [Language.PYTHON3]: 'PYTHON3',
};

export const VERDICT_NAME_TO_PROTO: Record<VerdictName, Verdict> = {
  PENDING: Verdict.PENDING,
  JUDGING: Verdict.JUDGING,
  ACCEPTED: Verdict.ACCEPTED,
  WRONG_ANSWER: Verdict.WRONG_ANSWER,
  TIME_LIMIT_EXCEEDED: Verdict.TIME_LIMIT_EXCEEDED,
  MEMORY_LIMIT_EXCEEDED: Verdict.MEMORY_LIMIT_EXCEEDED,
  RUNTIME_ERROR: Verdict.RUNTIME_ERROR,
  COMPILATION_ERROR: Verdict.COMPILATION_ERROR,
  INTERNAL_ERROR: Verdict.INTERNAL_ERROR,
};

export const PROTO_TO_VERDICT_NAME: Partial<Record<Verdict | number, VerdictName>> = {
  [Verdict.PENDING]: 'PENDING',
  [Verdict.JUDGING]: 'JUDGING',
  [Verdict.ACCEPTED]: 'ACCEPTED',
  [Verdict.WRONG_ANSWER]: 'WRONG_ANSWER',
  [Verdict.TIME_LIMIT_EXCEEDED]: 'TIME_LIMIT_EXCEEDED',
  [Verdict.MEMORY_LIMIT_EXCEEDED]: 'MEMORY_LIMIT_EXCEEDED',
  [Verdict.RUNTIME_ERROR]: 'RUNTIME_ERROR',
  [Verdict.COMPILATION_ERROR]: 'COMPILATION_ERROR',
  [Verdict.INTERNAL_ERROR]: 'INTERNAL_ERROR',
};

interface CursorPayload {
  s: string; // ISO string
  id: string;
}

export function encodeCursor(submittedAt: Date, id: string): string {
  const payload: CursorPayload = { s: submittedAt.toISOString(), id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(token: string): CursorPayload | undefined {
  try {
    const raw = Buffer.from(token, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw) as CursorPayload;
    if (typeof parsed.s === 'string' && typeof parsed.id === 'string') {
      return parsed;
    }
  } catch {
    // cursor inválido
  }
  return undefined;
}

export interface SubmissionsRepository {
  createWithCreatedEvent(input: NewSubmission): Promise<SubmissionRow>;
  findById(id: string): Promise<SubmissionRow | undefined>;
  list(params: ListSubmissionsParams): Promise<ListSubmissionsResult>;
  updateVerdict(event: SubmissionJudgedEvent): Promise<boolean>;
}

export class DrizzleSubmissionsRepository implements SubmissionsRepository {
  constructor(private readonly db: Db) {}

  async createWithCreatedEvent(input: NewSubmission): Promise<SubmissionRow> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(submissions)
        .values({
          userId: input.userId,
          problemId: input.problemId,
          contestId: input.contestId ?? null,
          language: input.language,
          sourceCode: input.sourceCode,
          verdict: 'PENDING',
        })
        .returning();

      if (!row) throw new Error('INSERT submissions no devolvió filas');

      const protoLanguage = LANGUAGE_NAME_TO_PROTO[input.language];
      const event = encodeEvent(Topics.SUBMISSION_CREATED, {
        submissionId: row.id,
        userId: row.userId,
        problemId: row.problemId,
        contestId: row.contestId ?? undefined,
        language: protoLanguage,
        sourceCode: row.sourceCode,
      });

      await tx.insert(outbox).values({
        eventId: event.event.eventId,
        topic: Topics.SUBMISSION_CREATED,
        messageKey: event.key,
        payload: event.value,
        headers: event.headers,
      });

      return row;
    });
  }

  async findById(id: string): Promise<SubmissionRow | undefined> {
    const [row] = await this.db.select().from(submissions).where(eq(submissions.id, id)).limit(1);
    return row;
  }

  async list(params: ListSubmissionsParams): Promise<ListSubmissionsResult> {
    const conditions = [];

    if (params.userId) {
      conditions.push(eq(submissions.userId, params.userId));
    }
    if (params.problemId) {
      conditions.push(eq(submissions.problemId, params.problemId));
    }
    if (params.contestId) {
      conditions.push(eq(submissions.contestId, params.contestId));
    }

    if (params.pageToken) {
      const cursor = decodeCursor(params.pageToken);
      if (cursor) {
        const cursorDate = new Date(cursor.s);
        conditions.push(
          or(
            lt(submissions.submittedAt, cursorDate),
            and(eq(submissions.submittedAt, cursorDate), lt(submissions.id, cursor.id)),
          ),
        );
      }
    }

    const limit = Math.max(1, Math.min(params.pageSize, 100));
    const query = this.db
      .select()
      .from(submissions)
      .orderBy(desc(submissions.submittedAt), desc(submissions.id))
      .limit(limit + 1);

    const rows = conditions.length > 0 ? await query.where(and(...conditions)) : await query;

    let nextPageToken: string | undefined;
    if (rows.length > limit) {
      rows.pop();
      const last = rows[rows.length - 1];
      if (last) {
        nextPageToken = encodeCursor(last.submittedAt, last.id);
      }
    }

    return {
      submissions: rows,
      nextPageToken,
    };
  }

  async updateVerdict(event: SubmissionJudgedEvent): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      // 1. Deduplicación por event_id
      const [dedupe] = await tx
        .insert(processedEvents)
        .values({
          eventId: event.eventId,
          topic: Topics.SUBMISSION_JUDGED,
        })
        .onConflictDoNothing()
        .returning({ eventId: processedEvents.eventId });

      if (!dedupe) {
        // Evento ya procesado previamente
        return false;
      }

      // 2. Actualizar submission
      await tx
        .update(submissions)
        .set({
          verdict: event.verdict,
          timeMs: event.timeMs,
          memoryKb: event.memoryKb,
          passedCases: event.passedCases,
          totalCases: event.totalCases,
          judgedAt: new Date(),
        })
        .where(eq(submissions.id, event.submissionId));

      return true;
    });
  }
}
