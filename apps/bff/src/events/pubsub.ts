import { EventEmitter } from 'node:events';

/**
 * PubSub en memoria (una instancia por réplica del BFF). `subscribe` registra al
 * suscriptor de inmediato (no en el primer `next()`), así quien se suscribe y después
 * consulta el estado actual no pierde eventos publicados entre medio.
 */
export class PubSub<T> {
  private readonly emitter = new EventEmitter();

  constructor(private readonly maxQueue = 100) {
    this.emitter.setMaxListeners(0);
  }

  publish(channel: string, payload: T): void {
    this.emitter.emit(channel, payload);
  }

  listenerCount(channel: string): number {
    return this.emitter.listenerCount(channel);
  }

  /** Iterador de los eventos del canal. Si el consumidor no lee, descarta los más antiguos. */
  subscribe(channel: string): AsyncIterableIterator<T> {
    const queue: T[] = [];
    let pending: ((r: IteratorResult<T>) => void) | undefined;
    let done = false;

    const listener = (payload: T) => {
      if (pending) {
        const resolve = pending;
        pending = undefined;
        resolve({ value: payload, done: false });
        return;
      }
      queue.push(payload);
      if (queue.length > this.maxQueue) queue.shift();
    };
    this.emitter.on(channel, listener);

    const finish = (): Promise<IteratorResult<T>> => {
      if (!done) {
        done = true;
        this.emitter.off(channel, listener);
        queue.length = 0;
        pending?.({ value: undefined, done: true });
        pending = undefined;
      }
      return Promise.resolve({ value: undefined, done: true });
    };

    return {
      next: () => {
        if (queue.length > 0) return Promise.resolve({ value: queue.shift() as T, done: false });
        if (done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (pending = resolve));
      },
      return: finish,
      throw: async (err) => {
        await finish();
        throw err;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }
}
