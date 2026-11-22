import { Inject } from '@nestjs/common';
import { Args, Context, Resolver, Subscription } from '@nestjs/graphql';
import { scoreboardChannel, submissionChannel } from '../../events/judged.js';
import type { JudgedEvent } from '../../events/judged.js';
import type { PubSub } from '../../events/pubsub.js';
import type { ScoreboardUpdate } from '../../gen/graphql.js';
import type { Backend } from '../../grpc/backend.js';
import { ErrorCode, gqlError, isNotFound } from '../../grpc/errors.js';
import { BACKEND, PUBSUB } from '../../tokens.js';
import { requireUser } from '../context.js';
import type { GqlContext } from '../context.js';
import { FINAL_VERDICTS, mapSubmission } from '../mappers.js';
import type { SubmissionModel } from '../mappers.js';

/** Aplica un veredicto recibido por Kafka sobre la submission conocida. */
export function applyJudged(current: SubmissionModel, ev: JudgedEvent): SubmissionModel {
  const final = FINAL_VERDICTS.has(ev.verdict);
  return {
    ...current,
    verdict: ev.verdict,
    timeMs: final ? ev.timeMs : null,
    memoryKb: final ? ev.memoryKb : null,
    passedCases: final ? ev.passedCases : null,
    totalCases: final ? ev.totalCases : null,
    judgedAt: final ? ev.judgedAt : null,
  };
}

/**
 * Envuelve un async generator que lee de `source` para que `return()` (el cliente canceló
 * la subscription) cierre primero la fuente: un async generator suspendido en un `await`
 * encola el `return()` hasta su próximo `yield`, que nunca llegaría sin eventos.
 */
export function closingWith<T>(
  gen: AsyncGenerator<T>,
  source: AsyncIterableIterator<unknown>,
): AsyncIterableIterator<T> {
  return {
    next: () => gen.next(),
    return: async (value?: unknown) => {
      await source.return?.();
      return gen.return(value as T);
    },
    throw: async (err?: unknown) => {
      await source.return?.();
      return gen.throw(err);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

const stateKey = (s: SubmissionModel) =>
  [s.verdict, s.timeMs, s.memoryKb, s.passedCases, s.totalCases].join('|');

/**
 * Emite el estado actual si ya tiene veredicto final y después cada cambio. Descarta un
 * evento que repite el estado ya emitido (el veredicto pudo llegar entre la suscripción al
 * PubSub y la consulta a submissions).
 */
export async function* submissionUpdates(
  base: SubmissionModel,
  events: AsyncIterableIterator<JudgedEvent>,
): AsyncGenerator<{ submissionUpdated: SubmissionModel }> {
  let current = base;
  let lastKey: string | undefined;
  try {
    if (FINAL_VERDICTS.has(base.verdict)) {
      lastKey = stateKey(base);
      yield { submissionUpdated: base };
    }
    for await (const ev of events) {
      current = applyJudged(current, ev);
      const key = stateKey(current);
      if (key === lastKey) continue;
      lastKey = key;
      yield { submissionUpdated: current };
    }
  } finally {
    await events.return?.();
  }
}

async function* scoreboardUpdates(
  events: AsyncIterableIterator<JudgedEvent>,
): AsyncGenerator<{ scoreboardUpdated: ScoreboardUpdate }> {
  try {
    for await (const ev of events) {
      if (!ev.contestId) continue;
      yield {
        scoreboardUpdated: {
          contestId: ev.contestId,
          submissionId: ev.submissionId,
          judgedAt: ev.judgedAt,
        },
      };
    }
  } finally {
    await events.return?.();
  }
}

@Resolver()
export class SubscriptionsResolver {
  constructor(
    @Inject(BACKEND) private readonly backend: Backend,
    @Inject(PUBSUB) private readonly pubsub: PubSub<JudgedEvent>,
  ) {}

  /** Solo el dueño de la submission o un ADMIN. */
  @Subscription('submissionUpdated')
  async submissionUpdated(@Args('id') id: string, @Context() ctx: GqlContext) {
    const viewer = requireUser(ctx);
    // Primero se escucha el canal y después se consulta el estado: así no se pierde un
    // veredicto que llegue mientras tanto.
    const events = this.pubsub.subscribe(submissionChannel(id));
    try {
      const res = await this.backend.submissions.getSubmission({ id }, ctx.meta);
      if (!res.submission) throw gqlError(ErrorCode.NOT_FOUND, 'La submission no existe.');
      if (res.submission.userId !== viewer.sub && viewer.role !== 'ADMIN') {
        throw gqlError(
          ErrorCode.FORBIDDEN,
          'Solo el dueño de la submission o un ADMIN pueden seguirla en vivo.',
        );
      }
      const base = mapSubmission(res.submission, viewer, { includeSource: true });
      return closingWith(submissionUpdates(base, events), events);
    } catch (err) {
      await events.return?.();
      if (isNotFound(err)) throw gqlError(ErrorCode.NOT_FOUND, 'La submission no existe.');
      throw err;
    }
  }

  @Subscription('scoreboardUpdated')
  scoreboardUpdated(@Args('contestId') contestId: string, @Context() ctx: GqlContext) {
    requireUser(ctx);
    const events = this.pubsub.subscribe(scoreboardChannel(contestId));
    return closingWith(scoreboardUpdates(events), events);
  }
}
