import { Code, ConnectError } from '@connectrpc/connect';
import { isUuid } from '../domain/contest.js';
import type { ContestCursor } from '../repository.js';

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decode(token: string): unknown {
  try {
    return JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new ConnectError('page_token inválido', Code.InvalidArgument);
  }
}

/** page_size: 0 = valor por defecto; negativo es inválido; se acota al máximo. */
export function pageSize(requested: number, def: number, max: number): number {
  if (requested < 0)
    throw new ConnectError('page_size no puede ser negativo', Code.InvalidArgument);
  return Math.min(requested || def, max);
}

export function encodeContestCursor(c: ContestCursor): string {
  return encode({ s: c.startTime.toISOString(), i: c.id });
}

export function decodeContestCursor(token: string): ContestCursor | undefined {
  if (!token) return undefined;
  const v = decode(token) as { s?: unknown; i?: unknown } | null;
  const startTime = typeof v?.s === 'string' ? new Date(v.s) : undefined;
  if (!startTime || Number.isNaN(startTime.getTime()) || typeof v?.i !== 'string' || !isUuid(v.i)) {
    throw new ConnectError('page_token inválido', Code.InvalidArgument);
  }
  return { startTime, id: v.i };
}

export function encodeOffset(offset: number): string {
  return encode({ o: offset });
}

export function decodeOffset(token: string): number {
  if (!token) return 0;
  const v = decode(token) as { o?: unknown } | null;
  if (typeof v?.o !== 'number' || !Number.isInteger(v.o) || v.o < 0) {
    throw new ConnectError('page_token inválido', Code.InvalidArgument);
  }
  return v.o;
}
