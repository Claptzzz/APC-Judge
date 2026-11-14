import { encodeEvent, Topics } from '@juez/contracts';
import { eq, inArray, or, sql } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { findUniqueViolation } from './db/errors.js';
import { outbox, UNIQUE_CONSTRAINTS, users } from './db/schema.js';
import type { RoleName, UserRow } from './db/schema.js';

export interface UserRecord {
  id: string;
  username: string;
  email: string;
  role: RoleName;
  passwordHash: string;
  createdAt: Date;
}

export interface NewUser {
  username: string;
  /** Ya normalizado en minúsculas. */
  email: string;
  passwordHash: string;
  role: RoleName;
}

export class DuplicateUserError extends Error {
  override name = 'DuplicateUserError';
  constructor(public readonly field: 'username' | 'email') {
    super(`${field} duplicado`);
  }
}

export interface UsersRepository {
  /** Inserta el usuario y su evento `user.registered` en el outbox, en una sola transacción. */
  createWithRegisteredEvent(user: NewUser): Promise<UserRecord>;
  /** Busca por username (sin distinguir mayúsculas) o por email. */
  findByLogin(usernameOrEmail: string): Promise<UserRecord | undefined>;
  findById(id: string): Promise<UserRecord | undefined>;
  findByIds(ids: readonly string[]): Promise<UserRecord[]>;
}

function toRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
    passwordHash: row.passwordHash,
    createdAt: row.createdAt,
  };
}

export class DrizzleUsersRepository implements UsersRepository {
  constructor(private readonly db: Db) {}

  async createWithRegisteredEvent(user: NewUser): Promise<UserRecord> {
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx.insert(users).values(user).returning();
        if (!row) throw new Error('INSERT users no devolvió filas');
        const event = encodeEvent(Topics.USER_REGISTERED, {
          userId: row.id,
          username: row.username,
        });
        await tx.insert(outbox).values({
          eventId: event.event.eventId,
          topic: Topics.USER_REGISTERED,
          messageKey: event.key,
          payload: event.value,
          headers: event.headers,
        });
        return toRecord(row);
      });
    } catch (err) {
      const violation = findUniqueViolation(err);
      if (violation?.constraint === UNIQUE_CONSTRAINTS.username) {
        throw new DuplicateUserError('username');
      }
      if (violation?.constraint === UNIQUE_CONSTRAINTS.email) throw new DuplicateUserError('email');
      throw err;
    }
  }

  async findByLogin(usernameOrEmail: string): Promise<UserRecord | undefined> {
    const value = usernameOrEmail.trim().toLowerCase();
    const [row] = await this.db
      .select()
      .from(users)
      .where(or(eq(sql`lower(${users.username})`, value), eq(users.email, value)))
      .limit(1);
    return row ? toRecord(row) : undefined;
  }

  async findById(id: string): Promise<UserRecord | undefined> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return row ? toRecord(row) : undefined;
  }

  async findByIds(ids: readonly string[]): Promise<UserRecord[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select()
      .from(users)
      .where(inArray(users.id, [...ids]));
    return rows.map(toRecord);
  }
}
