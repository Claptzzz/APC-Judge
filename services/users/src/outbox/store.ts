import { asc, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { outbox } from '../db/schema.js';

export interface OutboxMessage {
  id: number;
  topic: string;
  key: string;
  value: Buffer;
  headers: Record<string, string>;
}

export interface OutboxStore {
  /**
   * Toma hasta `limit` mensajes pendientes con `FOR UPDATE SKIP LOCKED`, los entrega a
   * `publish` y, si este no falla, los marca como publicados, todo en una transacción.
   * Si `publish` lanza, la transacción se revierte y los mensajes siguen pendientes.
   * Devuelve cuántos mensajes se publicaron.
   */
  publishPending(
    limit: number,
    publish: (messages: OutboxMessage[]) => Promise<void>,
  ): Promise<number>;
}

export class DrizzleOutboxStore implements OutboxStore {
  constructor(private readonly db: Db) {}

  publishPending(limit: number, publish: (messages: OutboxMessage[]) => Promise<void>) {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: outbox.id,
          topic: outbox.topic,
          key: outbox.messageKey,
          value: outbox.payload,
          headers: outbox.headers,
        })
        .from(outbox)
        .where(isNull(outbox.publishedAt))
        .orderBy(asc(outbox.id))
        .limit(limit)
        .for('update', { skipLocked: true });
      if (rows.length === 0) return 0;

      await publish(rows);

      await tx
        .update(outbox)
        .set({ publishedAt: new Date() })
        .where(
          inArray(
            outbox.id,
            rows.map((r) => r.id),
          ),
        );
      return rows.length;
    });
  }
}
