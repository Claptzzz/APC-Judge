import { describe, expect, it } from 'vitest';
import {
  baseTopic,
  DLQ_TOPICS,
  dlqTopic,
  DlqTopics,
  isDlqTopic,
  isTopic,
  TOPIC_PARTITIONS,
  TOPICS,
  Topics,
} from './topics.js';

describe('topics', () => {
  it('expone los 3 topics y sus DLQ', () => {
    expect(TOPICS).toEqual(['user.registered', 'submission.created', 'submission.judged']);
    expect(DLQ_TOPICS).toEqual([
      'user.registered.dlq',
      'submission.created.dlq',
      'submission.judged.dlq',
    ]);
    expect(TOPIC_PARTITIONS).toBe(3);
  });

  it('dlqTopic y baseTopic son inversas', () => {
    for (const topic of TOPICS) {
      expect(baseTopic(dlqTopic(topic))).toBe(topic);
      expect(baseTopic(topic)).toBe(topic);
    }
    expect(dlqTopic(Topics.SUBMISSION_JUDGED)).toBe(DlqTopics.SUBMISSION_JUDGED);
  });

  it('baseTopic rechaza topics desconocidos', () => {
    expect(() => baseTopic('foo.dlq' as never)).toThrow(/desconocido/);
  });

  it('isTopic / isDlqTopic', () => {
    expect(isTopic('user.registered')).toBe(true);
    expect(isTopic('user.registered.dlq')).toBe(false);
    expect(isDlqTopic('user.registered.dlq')).toBe(true);
    expect(isDlqTopic('user.registered')).toBe(false);
  });
});
