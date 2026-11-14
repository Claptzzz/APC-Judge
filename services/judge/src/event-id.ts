import { createHash } from 'node:crypto';

/**
 * Namespace UUID fijo del judge para derivar el `event_id` de `submission.judged`.
 * No debe cambiar: si cambia, un reproceso generaría un `event_id` distinto.
 */
export const JUDGED_EVENT_NAMESPACE = 'fc973b7e-d0c6-4f79-bc69-56e763b304cd';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidToBytes(uuid: string): Buffer {
  if (!UUID_RE.test(uuid)) throw new Error(`UUID inválido: ${uuid}`);
  return Buffer.from(uuid.replaceAll('-', ''), 'hex');
}

/** UUID v5 (RFC 9562): SHA-1 de namespace + nombre. */
export function uuidV5(name: string, namespace: string): string {
  const hash = createHash('sha1').update(uuidToBytes(namespace)).update(name, 'utf8').digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** `event_id` determinista del `SubmissionJudged` de una submission. */
export function judgedEventId(submissionId: string): string {
  return uuidV5(submissionId, JUDGED_EVENT_NAMESPACE);
}
