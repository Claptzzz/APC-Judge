import { timestampDate } from '@bufbuild/protobuf/wkt';
import type { SubmissionJudged, UserRegistered } from '@juez/contracts/es';
import { isUuid } from '../domain/contest.js';
import { PROTO_TO_VERDICT } from '../domain/verdicts.js';
import type { Logger } from '../logger.js';
import type { ScoreboardProjector } from '../projection/projector.js';
import type { RankingRepository, SubmissionJudgedData, UserRegisteredData } from '../repository.js';

/** El evento se deserializó pero sus datos no son válidos: va directo a la DLQ. */
export class InvalidEventError extends Error {
  override name = 'InvalidEventError';
}

export type EventOutcome = 'processed' | 'duplicate';

function requireUuid(value: string, field: string): string {
  if (!isUuid(value)) throw new InvalidEventError(`${field} no es un UUID: "${value}"`);
  return value.toLowerCase();
}

function requireEventId(value: string): string {
  if (!value.trim()) throw new InvalidEventError('event_id vacío');
  return value;
}

export function parseUserRegistered(e: UserRegistered): UserRegisteredData {
  const username = e.username.trim();
  if (!username) throw new InvalidEventError('username vacío');
  return {
    eventId: requireEventId(e.eventId),
    userId: requireUuid(e.userId, 'user_id'),
    username,
  };
}

export function parseSubmissionJudged(e: SubmissionJudged, now: Date): SubmissionJudgedData {
  const verdict = PROTO_TO_VERDICT[e.verdict];
  if (!verdict) throw new InvalidEventError(`veredicto no final o desconocido: ${e.verdict}`);
  if (!e.submittedAt) throw new InvalidEventError('submitted_at ausente');
  const contestId = e.contestId ? requireUuid(e.contestId, 'contest_id') : null;
  return {
    eventId: requireEventId(e.eventId),
    submissionId: requireUuid(e.submissionId, 'submission_id'),
    userId: requireUuid(e.userId, 'user_id'),
    problemId: requireUuid(e.problemId, 'problem_id'),
    contestId,
    verdict,
    submittedAt: timestampDate(e.submittedAt),
    judgedAt: e.occurredAt ? timestampDate(e.occurredAt) : now,
  };
}

export interface EventProcessorDeps {
  repo: RankingRepository;
  projector: ScoreboardProjector;
  logger: Logger;
  now?: () => Date;
}

/**
 * Aplica los eventos. No conoce Kafka ni llama a otros servicios.
 * 1. Transacción en Postgres (dedupe por event_id + dato). Si falla, el error se propaga y el
 *    consumidor no hace commit del offset.
 * 2. Tras el commit, re-proyecta en Redis la fila del usuario afectado. Esto nunca lanza: un
 *    fallo de Redis deja la proyección degradada pero no reintenta el evento.
 *    También se re-proyecta ante un duplicado: si el proceso cayó entre el commit y la
 *    escritura en Redis, la re-entrega del evento repara la fila.
 */
export class EventProcessor {
  private readonly now: () => Date;

  constructor(private readonly deps: EventProcessorDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async userRegistered(event: UserRegistered): Promise<EventOutcome> {
    const data = parseUserRegistered(event);
    const applied = await this.deps.repo.applyUserRegistered(data);
    await this.deps.projector.projectUserEverywhere(data.userId);
    return applied ? 'processed' : 'duplicate';
  }

  async submissionJudged(event: SubmissionJudged): Promise<EventOutcome> {
    const data = parseSubmissionJudged(event, this.now());
    const applied = await this.deps.repo.applySubmissionJudged(data);
    if (data.contestId) await this.deps.projector.projectUser(data.contestId, data.userId);
    return applied ? 'processed' : 'duplicate';
  }
}
