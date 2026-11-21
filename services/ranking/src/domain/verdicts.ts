import { Verdict } from '@juez/contracts/es';
import type { VerdictName } from './types.js';

/** Veredicto protobuf -> nombre guardado en la BD (solo veredictos finales). */
export const PROTO_TO_VERDICT: Partial<Record<Verdict, VerdictName>> = {
  [Verdict.ACCEPTED]: 'ACCEPTED',
  [Verdict.WRONG_ANSWER]: 'WRONG_ANSWER',
  [Verdict.TIME_LIMIT_EXCEEDED]: 'TIME_LIMIT_EXCEEDED',
  [Verdict.MEMORY_LIMIT_EXCEEDED]: 'MEMORY_LIMIT_EXCEEDED',
  [Verdict.RUNTIME_ERROR]: 'RUNTIME_ERROR',
  [Verdict.COMPILATION_ERROR]: 'COMPILATION_ERROR',
  [Verdict.INTERNAL_ERROR]: 'INTERNAL_ERROR',
};

export const VERDICT_TO_PROTO: Record<VerdictName, Verdict> = {
  ACCEPTED: Verdict.ACCEPTED,
  WRONG_ANSWER: Verdict.WRONG_ANSWER,
  TIME_LIMIT_EXCEEDED: Verdict.TIME_LIMIT_EXCEEDED,
  MEMORY_LIMIT_EXCEEDED: Verdict.MEMORY_LIMIT_EXCEEDED,
  RUNTIME_ERROR: Verdict.RUNTIME_ERROR,
  COMPILATION_ERROR: Verdict.COMPILATION_ERROR,
  INTERNAL_ERROR: Verdict.INTERNAL_ERROR,
};
