import { describe, expect, it, vi } from 'vitest';
import { JudgedConsumer } from './judged.consumer.js';
import { createLogger } from '../logger.js';
import { createMetrics } from '../metrics.js';
import type { SubmissionsRepository } from '../repository.js';
import { encodeEvent, Topics } from '@juez/contracts';
import { Verdict } from '@juez/contracts/es';
import type { Consumer, KafkaMessage, Producer } from 'kafkajs';

describe('JudgedConsumer', () => {
  const logger = createLogger('silent');
  const metrics = createMetrics({ defaultMetrics: false });

  it('procesa evento submission.judged y actualiza repositorio', async () => {
    const fakeRepo = {
      updateVerdict: vi.fn().mockResolvedValue(true),
    } as unknown as SubmissionsRepository;

    const fakeConsumer = {
      connect: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockResolvedValue(undefined),
      run: vi.fn(),
      commitOffsets: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    } as unknown as Consumer;

    const fakeProducer = {
      connect: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue([]),
    } as unknown as Producer;

    const consumer = new JudgedConsumer({
      consumer: fakeConsumer,
      producer: fakeProducer,
      repo: fakeRepo,
      logger,
      metrics,
    });

    const event = encodeEvent(Topics.SUBMISSION_JUDGED, {
      submissionId: '550e8400-e29b-41d4-a716-446655440000',
      userId: '660e8400-e29b-41d4-a716-446655440000',
      problemId: '770e8400-e29b-41d4-a716-446655440000',
      verdict: Verdict.ACCEPTED,
      timeMs: 42,
      memoryKb: 1024,
      passedCases: 10,
      totalCases: 10,
    });

    // @ts-expect-error test invoke
    await consumer.handleMessage({
      topic: Topics.SUBMISSION_JUDGED,
      partition: 0,
      message: {
        offset: '10',
        key: Buffer.from(event.key),
        value: event.value,
        headers: event.headers,
      } as unknown as KafkaMessage,
    });

    expect(fakeRepo.updateVerdict).toHaveBeenCalledWith(
      expect.objectContaining({
        submissionId: '550e8400-e29b-41d4-a716-446655440000',
        verdict: 'ACCEPTED',
        timeMs: 42,
        memoryKb: 1024,
        passedCases: 10,
        totalCases: 10,
      }),
    );
    expect(fakeConsumer.commitOffsets).toHaveBeenCalledWith([
      { topic: Topics.SUBMISSION_JUDGED, partition: 0, offset: '11' },
    ]);
  });

  it('envía mensaje corrupto a DLQ y commitea offset', async () => {
    const fakeRepo = {
      updateVerdict: vi.fn(),
    } as unknown as SubmissionsRepository;

    const fakeConsumer = {
      commitOffsets: vi.fn().mockResolvedValue(undefined),
    } as unknown as Consumer;

    const fakeProducer = {
      send: vi.fn().mockResolvedValue([]),
    } as unknown as Producer;

    const consumer = new JudgedConsumer({
      consumer: fakeConsumer,
      producer: fakeProducer,
      repo: fakeRepo,
      logger,
      metrics,
    });

    // @ts-expect-error test invoke
    await consumer.handleMessage({
      topic: Topics.SUBMISSION_JUDGED,
      partition: 0,
      message: {
        offset: '5',
        key: Buffer.from('sub-1'),
        value: Buffer.from('corrupted-data'),
        headers: {},
      } as unknown as KafkaMessage,
    });

    expect(fakeRepo.updateVerdict).not.toHaveBeenCalled();
    expect(fakeProducer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: 'submission.judged.dlq',
      }),
    );
    expect(fakeConsumer.commitOffsets).toHaveBeenCalledWith([
      { topic: Topics.SUBMISSION_JUDGED, partition: 0, offset: '6' },
    ]);
  });
});
