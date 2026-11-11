import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import type { DescMessage, MessageInitShape, MessageShape } from '@bufbuild/protobuf';
import { timestampNow } from '@bufbuild/protobuf/wkt';
import {
  SubmissionCreatedSchema,
  SubmissionJudgedSchema,
  UserRegisteredSchema,
} from './gen/es/juez/events/v1/events_pb.js';
import { baseTopic, Topics } from './topics.js';
import type { DlqTopic, Topic } from './topics.js';

/** Schema protobuf-es del evento que viaja en cada topic. */
export const EVENT_SCHEMAS = {
  [Topics.USER_REGISTERED]: UserRegisteredSchema,
  [Topics.SUBMISSION_CREATED]: SubmissionCreatedSchema,
  [Topics.SUBMISSION_JUDGED]: SubmissionJudgedSchema,
} as const satisfies Record<Topic, DescMessage>;

/** Campo del evento que se usa como key del mensaje Kafka (id del agregado). */
export const EVENT_KEY_FIELDS = {
  [Topics.USER_REGISTERED]: 'userId',
  [Topics.SUBMISSION_CREATED]: 'submissionId',
  [Topics.SUBMISSION_JUDGED]: 'submissionId',
} as const satisfies Record<Topic, string>;

type SchemaOf<T extends Topic> = (typeof EVENT_SCHEMAS)[T];
type BaseOf<T extends Topic | DlqTopic> = T extends `${infer B extends Topic}.dlq` ? B : T;

/** Tipo del evento de un topic (o de su DLQ). */
export type EventOf<T extends Topic | DlqTopic> = MessageShape<SchemaOf<BaseOf<T>>>;
/** Datos para construir un evento; `eventId` y `occurredAt` son opcionales. */
export type EventInit<T extends Topic> = MessageInitShape<SchemaOf<T>>;

export const EVENT_CONTENT_TYPE = 'application/x-protobuf';

/** Mensaje listo para kafkajs: `producer.send({ topic, messages: [encodeEvent(topic, e)] })`. */
export interface EncodedEvent<T extends Topic> {
  key: string;
  value: Buffer;
  headers: {
    'content-type': typeof EVENT_CONTENT_TYPE;
    'event-type': string;
    'event-id': string;
  };
  /** Evento completo, con `eventId`/`occurredAt` ya asignados (útil para el outbox). */
  event: EventOf<T>;
}

/**
 * Serializa un evento a protobuf binario. Si faltan, asigna `eventId` (UUID v4) y
 * `occurredAt` (ahora). La key es el id del agregado (`userId` o `submissionId`).
 */
export function encodeEvent<T extends Topic>(topic: T, init: EventInit<T>): EncodedEvent<T> {
  const schema: DescMessage = EVENT_SCHEMAS[topic];
  const event = create(schema, init as MessageInitShape<DescMessage>) as unknown as EventOf<T> & {
    eventId: string;
    occurredAt?: unknown;
  };
  if (!event.eventId) event.eventId = crypto.randomUUID();
  if (!event.occurredAt) event.occurredAt = timestampNow();

  const key = (event as unknown as Record<string, unknown>)[EVENT_KEY_FIELDS[topic]];
  if (typeof key !== 'string' || key === '') {
    throw new Error(`El evento de ${topic} requiere ${EVENT_KEY_FIELDS[topic]} (key del mensaje)`);
  }

  const bytes = toBinary(schema, event as unknown as MessageShape<DescMessage>);
  return {
    key,
    value: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    headers: {
      'content-type': EVENT_CONTENT_TYPE,
      'event-type': schema.typeName,
      'event-id': event.eventId,
    },
    event,
  };
}

/**
 * Deserializa el valor de un mensaje Kafka. Acepta el topic base o su DLQ.
 * Lanza un error si el valor está vacío o no es protobuf válido para ese evento.
 */
export function decodeEvent<T extends Topic | DlqTopic>(
  topic: T,
  value: Uint8Array | null | undefined,
): EventOf<T> {
  const base = baseTopic(topic);
  if (!value || value.byteLength === 0) {
    throw new Error(`Mensaje vacío en ${topic}`);
  }
  return fromBinary(EVENT_SCHEMAS[base] as DescMessage, value) as unknown as EventOf<T>;
}
