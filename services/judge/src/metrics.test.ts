import { Verdict } from '@juez/contracts/es';
import { describe, expect, it } from 'vitest';
import { Metrics } from './metrics.js';

describe('Metrics', () => {
  it('cuenta veredictos, DLQ y duración', () => {
    const metrics = new Metrics();
    metrics.recordJudged(Verdict.ACCEPTED, 1500);
    metrics.recordJudged(Verdict.ACCEPTED, 500);
    metrics.recordJudged(Verdict.WRONG_ANSWER, 1000);
    metrics.recordDlq();
    const text = metrics.render();
    expect(text).toContain('judge_submissions_judged_total{verdict="ACCEPTED"} 2');
    expect(text).toContain('judge_submissions_judged_total{verdict="WRONG_ANSWER"} 1');
    expect(text).toContain('judge_dlq_messages_total 1');
    expect(text).toContain('judge_submission_duration_seconds_sum 3');
    expect(text).toContain('judge_submission_duration_seconds_count 3');
    expect(text.endsWith('\n')).toBe(true);
  });
});
