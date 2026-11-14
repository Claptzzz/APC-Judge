import { describe, expect, it } from 'vitest';
import {
  decodeCursor,
  DrizzleSubmissionsRepository,
  encodeCursor,
  LANGUAGE_NAME_TO_PROTO,
  PROTO_TO_LANGUAGE_NAME,
  PROTO_TO_VERDICT_NAME,
  VERDICT_NAME_TO_PROTO,
} from './repository.js';
import { Language, Verdict } from '@juez/contracts/es';
import { chainFake } from './test-utils/helpers.js';

describe('repository helpers', () => {
  describe('cursor pagination', () => {
    it('codifica y decodifica el cursor correctamente', () => {
      const now = new Date('2026-11-14T12:00:00.000Z');
      const id = '550e8400-e29b-41d4-a716-446655440000';
      const token = encodeCursor(now, id);
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);

      const decoded = decodeCursor(token);
      expect(decoded).toBeDefined();
      expect(decoded?.s).toBe(now.toISOString());
      expect(decoded?.id).toBe(id);
    });

    it('devuelve undefined para un token corrupto', () => {
      expect(decodeCursor('not-valid-base64-json')).toBeUndefined();
      expect(decodeCursor('')).toBeUndefined();
    });
  });

  describe('enum mappings', () => {
    it('mapea correctamente lenguajes en ambas direcciones', () => {
      expect(LANGUAGE_NAME_TO_PROTO.CPP17).toBe(Language.CPP17);
      expect(LANGUAGE_NAME_TO_PROTO.PYTHON3).toBe(Language.PYTHON3);

      expect(PROTO_TO_LANGUAGE_NAME[Language.CPP17]).toBe('CPP17');
      expect(PROTO_TO_LANGUAGE_NAME[Language.PYTHON3]).toBe('PYTHON3');
    });

    it('mapea correctamente veredictos en ambas direcciones', () => {
      expect(VERDICT_NAME_TO_PROTO.PENDING).toBe(Verdict.PENDING);
      expect(VERDICT_NAME_TO_PROTO.ACCEPTED).toBe(Verdict.ACCEPTED);
      expect(VERDICT_NAME_TO_PROTO.WRONG_ANSWER).toBe(Verdict.WRONG_ANSWER);
      expect(VERDICT_NAME_TO_PROTO.TIME_LIMIT_EXCEEDED).toBe(Verdict.TIME_LIMIT_EXCEEDED);
      expect(VERDICT_NAME_TO_PROTO.MEMORY_LIMIT_EXCEEDED).toBe(Verdict.MEMORY_LIMIT_EXCEEDED);
      expect(VERDICT_NAME_TO_PROTO.RUNTIME_ERROR).toBe(Verdict.RUNTIME_ERROR);
      expect(VERDICT_NAME_TO_PROTO.COMPILATION_ERROR).toBe(Verdict.COMPILATION_ERROR);
      expect(VERDICT_NAME_TO_PROTO.INTERNAL_ERROR).toBe(Verdict.INTERNAL_ERROR);

      expect(PROTO_TO_VERDICT_NAME[Verdict.ACCEPTED]).toBe('ACCEPTED');
      expect(PROTO_TO_VERDICT_NAME[Verdict.WRONG_ANSWER]).toBe('WRONG_ANSWER');
    });
  });

  describe('DrizzleSubmissionsRepository', () => {
    it('createWithCreatedEvent inserta submission y outbox en transacción', async () => {
      const createdRow = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        userId: '660e8400-e29b-41d4-a716-446655440000',
        problemId: '770e8400-e29b-41d4-a716-446655440000',
        contestId: null,
        language: 'CPP17',
        sourceCode: 'int main() {}',
        verdict: 'PENDING',
        timeMs: 0,
        memoryKb: 0,
        passedCases: 0,
        totalCases: 0,
        submittedAt: new Date(),
        judgedAt: null,
      };

      const { chain, calls } = chainFake([[createdRow], undefined]);
      const db = { transaction: (fn: (tx: unknown) => unknown) => fn(chain) };
      const repo = new DrizzleSubmissionsRepository(db as never);

      const res = await repo.createWithCreatedEvent({
        userId: createdRow.userId,
        problemId: createdRow.problemId,
        language: 'CPP17',
        sourceCode: createdRow.sourceCode,
      });

      expect(res.id).toBe(createdRow.id);
      expect(calls.filter((c) => c.method === 'insert').length).toBe(2);
    });

    it('findById busca por ID', async () => {
      const row = { id: 'sub-1' };
      const { chain } = chainFake([[row]]);
      const db = chain;
      const repo = new DrizzleSubmissionsRepository(db as never);

      const res = await repo.findById('sub-1');
      expect(res).toEqual(row);
    });

    it('updateVerdict inserta deduplicación y actualiza veredicto', async () => {
      const { chain } = chainFake([[{ eventId: 'ev-1' }], undefined]);
      const db = { transaction: (fn: (tx: unknown) => unknown) => fn(chain) };
      const repo = new DrizzleSubmissionsRepository(db as never);

      const ok = await repo.updateVerdict({
        eventId: 'ev-1',
        submissionId: 'sub-1',
        verdict: 'ACCEPTED',
        timeMs: 10,
        memoryKb: 2048,
        passedCases: 5,
        totalCases: 5,
      });

      expect(ok).toBe(true);
    });

    it('updateVerdict descarta duplicados si no se insertó en processedEvents', async () => {
      const { chain } = chainFake([[]]); // onConflictDoNothing devuelve vacío
      const db = { transaction: (fn: (tx: unknown) => unknown) => fn(chain) };
      const repo = new DrizzleSubmissionsRepository(db as never);

      const ok = await repo.updateVerdict({
        eventId: 'ev-duplicate',
        submissionId: 'sub-1',
        verdict: 'ACCEPTED',
        timeMs: 10,
        memoryKb: 2048,
        passedCases: 5,
        totalCases: 5,
      });

      expect(ok).toBe(false);
    });

    it('list aplica filtros y paginación', async () => {
      const rows = [
        { id: 'sub-1', submittedAt: new Date() },
        { id: 'sub-2', submittedAt: new Date() },
      ];
      const { chain } = chainFake([rows]);
      const db = chain;
      const repo = new DrizzleSubmissionsRepository(db as never);

      const res = await repo.list({
        pageSize: 10,
        userId: '550e8400-e29b-41d4-a716-446655440000',
        problemId: '660e8400-e29b-41d4-a716-446655440000',
        contestId: '770e8400-e29b-41d4-a716-446655440000',
        pageToken: encodeCursor(new Date(), '550e8400-e29b-41d4-a716-446655440000'),
      });

      expect(res.submissions.length).toBe(2);
    });
  });
});
