import { describe, expect, it } from 'vitest';
import { PubSub } from './pubsub.js';

describe('PubSub', () => {
  it('registra al suscriptor de inmediato (no pierde eventos antes del primer next)', async () => {
    const ps = new PubSub<number>();
    const it1 = ps.subscribe('c');
    ps.publish('c', 1);
    ps.publish('otro', 99);
    ps.publish('c', 2);
    expect((await it1.next()).value).toBe(1);
    expect((await it1.next()).value).toBe(2);
    const pending = it1.next();
    ps.publish('c', 3);
    expect((await pending).value).toBe(3);
  });

  it('return libera el listener y resuelve un next pendiente', async () => {
    const ps = new PubSub<number>();
    const it1 = ps.subscribe('c');
    const pending = it1.next();
    expect(ps.listenerCount('c')).toBe(1);
    await it1.return!();
    expect(await pending).toEqual({ value: undefined, done: true });
    expect(ps.listenerCount('c')).toBe(0);
    expect((await it1.next()).done).toBe(true);
    await expect(it1.throw!(new Error('x'))).rejects.toThrow('x');
  });

  it('acota la cola si el consumidor no lee', async () => {
    const ps = new PubSub<number>(2);
    const it1 = ps.subscribe('c');
    for (let i = 1; i <= 4; i++) ps.publish('c', i);
    expect((await it1.next()).value).toBe(3);
    expect((await it1.next()).value).toBe(4);
    expect(it1[Symbol.asyncIterator]()).toBe(it1);
  });
});
