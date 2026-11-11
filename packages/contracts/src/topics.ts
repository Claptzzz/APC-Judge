/** Topics Kafka del sistema. Cada uno tiene 3 particiones y su DLQ `<topic>.dlq`. */
export const Topics = {
  USER_REGISTERED: 'user.registered',
  SUBMISSION_CREATED: 'submission.created',
  SUBMISSION_JUDGED: 'submission.judged',
} as const;

export type Topic = (typeof Topics)[keyof typeof Topics];

export const DLQ_SUFFIX = '.dlq';

export type DlqTopic = `${Topic}${typeof DLQ_SUFFIX}`;

/** DLQ de cada topic. */
export const DlqTopics = {
  USER_REGISTERED: 'user.registered.dlq',
  SUBMISSION_CREATED: 'submission.created.dlq',
  SUBMISSION_JUDGED: 'submission.judged.dlq',
} as const satisfies Record<keyof typeof Topics, DlqTopic>;

export const TOPICS: readonly Topic[] = Object.values(Topics);
export const DLQ_TOPICS: readonly DlqTopic[] = Object.values(DlqTopics);

/** Particiones de cada topic (y de su DLQ). */
export const TOPIC_PARTITIONS = 3;

export function isTopic(value: string): value is Topic {
  return (TOPICS as readonly string[]).includes(value);
}

export function isDlqTopic(value: string): value is DlqTopic {
  return (DLQ_TOPICS as readonly string[]).includes(value);
}

/** `submission.judged` -> `submission.judged.dlq` */
export function dlqTopic<T extends Topic>(topic: T): `${T}${typeof DLQ_SUFFIX}` {
  return `${topic}${DLQ_SUFFIX}`;
}

/** `submission.judged.dlq` -> `submission.judged`; un topic base se devuelve tal cual. */
export function baseTopic(topic: Topic | DlqTopic): Topic {
  const base = topic.endsWith(DLQ_SUFFIX) ? topic.slice(0, -DLQ_SUFFIX.length) : topic;
  if (!isTopic(base)) throw new Error(`Topic desconocido: ${topic}`);
  return base;
}
