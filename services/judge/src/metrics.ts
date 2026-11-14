import { Verdict } from '@juez/contracts/es';

/** Métricas mínimas en formato de texto de Prometheus (sin dependencias). */
export class Metrics {
  private readonly judged = new Map<string, number>();
  private dlq = 0;
  private durationSum = 0;
  private durationCount = 0;

  recordJudged(verdict: Verdict, durationMs: number): void {
    const name = Verdict[verdict] ?? String(verdict);
    this.judged.set(name, (this.judged.get(name) ?? 0) + 1);
    this.durationSum += durationMs / 1000;
    this.durationCount++;
  }

  recordDlq(): void {
    this.dlq++;
  }

  render(): string {
    const lines = [
      '# HELP judge_submissions_judged_total Submissions juzgadas por veredicto.',
      '# TYPE judge_submissions_judged_total counter',
      ...[...this.judged.entries()].map(
        ([verdict, count]) => `judge_submissions_judged_total{verdict="${verdict}"} ${count}`,
      ),
      '# HELP judge_dlq_messages_total Mensajes enviados a submission.created.dlq.',
      '# TYPE judge_dlq_messages_total counter',
      `judge_dlq_messages_total ${this.dlq}`,
      '# HELP judge_submission_duration_seconds Tiempo total de evaluación por submission.',
      '# TYPE judge_submission_duration_seconds summary',
      `judge_submission_duration_seconds_sum ${this.durationSum}`,
      `judge_submission_duration_seconds_count ${this.durationCount}`,
    ];
    return `${lines.join('\n')}\n`;
  }
}
