import type { SubmissionJudged } from '@juez/contracts/es';
import type { Verdict } from '../gen/graphql.js';
import { isoFromTimestamp, verdictFromProto } from '../graphql/mappers.js';

/** Veredicto recibido por Kafka, ya en el lenguaje del schema. */
export interface JudgedEvent {
  eventId: string;
  submissionId: string;
  userId: string;
  problemId: string;
  contestId: string | null;
  verdict: Verdict;
  timeMs: number;
  memoryKb: number;
  passedCases: number;
  totalCases: number;
  submittedAt: string | null;
  /** `occurred_at` del evento: cuándo se juzgó. */
  judgedAt: string;
}

export const submissionChannel = (submissionId: string) => `submission:${submissionId}`;
export const scoreboardChannel = (contestId: string) => `scoreboard:${contestId}`;

/** SubmissionJudged (protobuf-es) → JudgedEvent. */
export function toJudgedEvent(e: SubmissionJudged, now: Date = new Date()): JudgedEvent {
  return {
    eventId: e.eventId,
    submissionId: e.submissionId,
    userId: e.userId,
    problemId: e.problemId,
    contestId: e.contestId ? e.contestId : null,
    verdict: verdictFromProto(e.verdict),
    timeMs: e.timeMs,
    memoryKb: e.memoryKb,
    passedCases: e.passedCases,
    totalCases: e.totalCases,
    submittedAt: isoFromTimestamp(e.submittedAt),
    judgedAt: isoFromTimestamp(e.occurredAt) ?? now.toISOString(),
  };
}
