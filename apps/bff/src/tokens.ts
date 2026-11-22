/** Tokens de inyección de Nest (todo se inyecta explícito, sin depender de metadata de tipos). */
export const CONFIG = Symbol('CONFIG');
export const LOGGER = Symbol('LOGGER');
export const METRICS = Symbol('METRICS');
export const BACKEND = Symbol('BACKEND');
export const VERIFIER = Symbol('VERIFIER');
export const PUBSUB = Symbol('PUBSUB');
export const ASSISTANT = Symbol('ASSISTANT');
export const CONSUMER = Symbol('CONSUMER');
