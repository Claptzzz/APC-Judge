export function chainFake(results: unknown[]) {
  const calls: { method: string; args: unknown[] }[] = [];
  const queue = [...results];
  const proxy: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') {
        const next = queue.shift();
        return (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
          next instanceof Error ? reject(next) : resolve(next);
      }
      return (...args: unknown[]) => {
        calls.push({ method: String(prop), args });
        return proxy;
      };
    },
  });
  return { chain: proxy as never, calls };
}
