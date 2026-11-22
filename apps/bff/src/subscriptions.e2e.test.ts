// Subscriptions con un cliente graphql-ws real contra la app (PubSub real, gRPC mockeado).
import { status as GrpcStatus } from '@grpc/grpc-js';
import { common } from '@juez/contracts/nest';
import { createClient } from 'graphql-ws';
import type { Client, FormattedExecutionResult } from 'graphql-ws';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { scoreboardChannel, submissionChannel } from './events/judged.js';
import {
  ADMIN,
  ALICE,
  BOB,
  CONTEST_ID,
  createKeys,
  sampleJudged,
  sampleSubmission,
  signToken,
  startTestApp,
  SUBMISSION_ID,
  ts,
  upstreamError,
} from './test-utils/fixtures.js';
import type { Keys, TestApp } from './test-utils/fixtures.js';

let keys: Keys;
let app: TestApp;
const clients: Client[] = [];

beforeAll(async () => {
  keys = await createKeys();
  app = await startTestApp(keys);
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.dispose()));
  // El servidor libera los listeners del PubSub al cerrar cada subscription.
  const channels = [submissionChannel(SUBMISSION_ID), scoreboardChannel(CONTEST_ID)];
  const deadline = Date.now() + 2000;
  while (channels.some((c) => app.pubsub.listenerCount(c) > 0)) {
    if (Date.now() > deadline) throw new Error('quedaron listeners colgando en el PubSub');
    await new Promise((r) => setTimeout(r, 10));
  }
});
afterAll(() => app.close());

function connect(token?: string, extra: Record<string, unknown> = {}): Client {
  const client = createClient({
    url: app.wsUrl,
    webSocketImpl: WebSocket,
    retryAttempts: 0,
    lazy: true,
    connectionParams: token ? { authorization: `Bearer ${token}`, ...extra } : extra,
  });
  clients.push(client);
  return client;
}

type Result = FormattedExecutionResult<Record<string, unknown>, unknown>;

/** Suscribe y devuelve una cola de resultados + una promesa de cierre. */
function subscribe(client: Client, query: string, variables: Record<string, unknown> = {}) {
  const results: Result[] = [];
  const waiters: Array<() => void> = [];
  let error: unknown;
  let completed = false;
  const notify = () => waiters.splice(0).forEach((w) => w());
  const dispose = client.subscribe<Record<string, unknown>>(
    { query, variables },
    {
      next: (r) => {
        results.push(r);
        notify();
      },
      error: (e) => {
        error = e;
        notify();
      },
      complete: () => {
        completed = true;
        notify();
      },
    },
  );
  const waitFor = async (pred: () => boolean, ms = 2000) => {
    const deadline = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error('timeout esperando la subscription');
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  };
  return {
    results,
    dispose,
    get error() {
      return error;
    },
    get completed() {
      return completed;
    },
    waitFor,
    nextResult: async (n: number) => {
      await waitFor(() => results.length >= n || completed || error !== undefined);
      return results[n - 1];
    },
  };
}

/** Espera a que el resolver se haya suscrito al canal del PubSub. */
async function waitListener(channel: string) {
  const deadline = Date.now() + 2000;
  while (app.pubsub.listenerCount(channel) === 0) {
    if (Date.now() > deadline) throw new Error(`nadie escucha ${channel}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const SUB = `subscription($id: ID!) {
  submissionUpdated(id: $id) {
    id verdict timeMs memoryKb passedCases totalCases judgedAt language sourceCode
    user { username } problem { title }
  }
}`;

describe('submissionUpdated', () => {
  it('el dueño recibe el veredicto cuando llega submission.judged', async () => {
    const token = await signToken(keys, ALICE);
    const sub = subscribe(connect(token), SUB, { id: SUBMISSION_ID });
    await waitListener(submissionChannel(SUBMISSION_ID));
    expect(sub.results).toHaveLength(0); // PENDING: no emite nada al suscribirse

    app.pubsub.publish(submissionChannel(SUBMISSION_ID), sampleJudged());
    const first = await sub.nextResult(1);
    expect(first?.errors).toBeUndefined();
    expect(first?.data).toEqual({
      submissionUpdated: {
        id: SUBMISSION_ID,
        verdict: 'WRONG_ANSWER',
        timeMs: 12,
        memoryKb: 3400,
        passedCases: 1,
        totalCases: 3,
        judgedAt: '2026-11-22T15:00:05.000Z',
        language: 'CPP17',
        sourceCode: 'int main(){}',
        user: { username: `u-${ALICE.sub.slice(0, 4)}` },
        problem: { title: 'Suma' },
      },
    });
    // Usa el token de connectionParams para las llamadas gRPC.
    expect(app.backend.submissions.getSubmission).toHaveBeenCalledWith(
      { id: SUBMISSION_ID },
      { token, requestId: expect.any(String) },
    );

    // Un evento repetido (mismo estado) no se reemite; un cambio sí.
    app.pubsub.publish(submissionChannel(SUBMISSION_ID), sampleJudged({ eventId: 'evt-dup' }));
    app.pubsub.publish(
      submissionChannel(SUBMISSION_ID),
      sampleJudged({ eventId: 'evt-2', verdict: 'ACCEPTED', passedCases: 3 }),
    );
    const second = await sub.nextResult(2);
    expect(second?.data).toMatchObject({
      submissionUpdated: { verdict: 'ACCEPTED', passedCases: 3 },
    });
    expect(sub.results).toHaveLength(2);
  });

  it('si ya tiene veredicto final, lo emite de inmediato', async () => {
    app.backend.submissions.getSubmission.mockResolvedValueOnce({
      submission: sampleSubmission({
        verdict: common.Verdict.VERDICT_ACCEPTED,
        timeMs: 20,
        memoryKb: 1000,
        passedCases: 3,
        totalCases: 3,
        judgedAt: ts('2026-11-22T15:00:02.000Z'),
      }),
    });
    const sub = subscribe(connect(await signToken(keys, ALICE)), SUB, { id: SUBMISSION_ID });
    const first = await sub.nextResult(1);
    expect(first?.data).toMatchObject({
      submissionUpdated: { verdict: 'ACCEPTED', judgedAt: '2026-11-22T15:00:02.000Z' },
    });
    // El evento del mismo veredicto que llega tarde no se duplica.
    app.pubsub.publish(
      submissionChannel(SUBMISSION_ID),
      sampleJudged({ verdict: 'ACCEPTED', timeMs: 20, memoryKb: 1000, passedCases: 3 }),
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(sub.results).toHaveLength(1);
  });

  it('otro CONTESTANT recibe FORBIDDEN; un ADMIN puede seguirla', async () => {
    const other = subscribe(connect(await signToken(keys, BOB)), SUB, { id: SUBMISSION_ID });
    const denied = await other.nextResult(1);
    const err = denied?.errors ?? (other.error as Array<{ extensions?: { code?: string } }>);
    expect(err?.[0]?.extensions?.code).toBe('FORBIDDEN');
    // Al rechazar no queda escuchando el canal.
    expect(app.pubsub.listenerCount(submissionChannel(SUBMISSION_ID))).toBe(0);

    const admin = subscribe(connect(await signToken(keys, ADMIN)), SUB, { id: SUBMISSION_ID });
    await waitListener(submissionChannel(SUBMISSION_ID));
    app.pubsub.publish(submissionChannel(SUBMISSION_ID), sampleJudged());
    const r = await admin.nextResult(1);
    expect(r?.data).toMatchObject({ submissionUpdated: { verdict: 'WRONG_ANSWER' } });
  });

  it('submission inexistente → NOT_FOUND; submissions caído → UNAVAILABLE', async () => {
    const token = await signToken(keys, ALICE);
    app.backend.submissions.getSubmission.mockRejectedValueOnce(
      upstreamError('submissions', GrpcStatus.NOT_FOUND),
    );
    const nf = subscribe(connect(token), SUB, { id: 'x' });
    const r = await nf.nextResult(1);
    const errs = r?.errors ?? (nf.error as Array<{ extensions?: { code?: string } }>);
    expect(errs?.[0]?.extensions?.code).toBe('NOT_FOUND');

    app.backend.submissions.getSubmission.mockRejectedValueOnce(
      upstreamError('submissions', GrpcStatus.UNAVAILABLE),
    );
    const down = subscribe(connect(token), SUB, { id: 'y' });
    const r2 = await down.nextResult(1);
    const errs2 = r2?.errors ?? (down.error as Array<{ extensions?: { code?: string } }>);
    expect(errs2?.[0]?.extensions?.code).toBe('UNAVAILABLE');
  });

  it('sin token → UNAUTHENTICATED; con token inválido se rechaza la conexión', async () => {
    const anon = subscribe(connect(), SUB, { id: SUBMISSION_ID });
    const r = await anon.nextResult(1);
    const errs = r?.errors ?? (anon.error as Array<{ extensions?: { code?: string } }>);
    expect(errs?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');

    const bad = subscribe(connect('no-es-un-jwt'), SUB, { id: SUBMISSION_ID });
    await bad.waitFor(() => bad.error !== undefined);
    expect((bad.error as { code?: number }).code).toBe(4403);
  });

  it('al cancelar la subscription deja de escuchar el canal', async () => {
    const sub = subscribe(connect(await signToken(keys, ALICE)), SUB, { id: SUBMISSION_ID });
    await waitListener(submissionChannel(SUBMISSION_ID));
    sub.dispose();
    const deadline = Date.now() + 2000;
    while (app.pubsub.listenerCount(submissionChannel(SUBMISSION_ID)) > 0) {
      if (Date.now() > deadline) throw new Error('el listener no se liberó');
      await new Promise((r) => setTimeout(r, 10));
    }
  });
});

describe('scoreboardUpdated', () => {
  const SCORE = `subscription($c: ID!) { scoreboardUpdated(contestId: $c) { contestId submissionId judgedAt } }`;

  it('emite cuando el evento trae contest_id del contest suscrito', async () => {
    const sub = subscribe(connect(await signToken(keys, BOB)), SCORE, { c: CONTEST_ID });
    await waitListener(scoreboardChannel(CONTEST_ID));
    app.pubsub.publish(
      scoreboardChannel('otro-contest'),
      sampleJudged({ contestId: 'otro-contest' }),
    );
    app.pubsub.publish(scoreboardChannel(CONTEST_ID), sampleJudged({ contestId: CONTEST_ID }));
    const r = await sub.nextResult(1);
    expect(r?.data).toEqual({
      scoreboardUpdated: {
        contestId: CONTEST_ID,
        submissionId: SUBMISSION_ID,
        judgedAt: '2026-11-22T15:00:05.000Z',
      },
    });
    expect(sub.results).toHaveLength(1);
  });

  it('requiere sesión', async () => {
    const sub = subscribe(connect(), SCORE, { c: CONTEST_ID });
    const r = await sub.nextResult(1);
    const errs = r?.errors ?? (sub.error as Array<{ extensions?: { code?: string } }>);
    expect(errs?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
  });
});
