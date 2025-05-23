export const isFailedPromise = (x: unknown) => Bun.peek(x) instanceof Error;

export const memoize = <F extends (...args: any[]) => any>(
  f: F,
  key: (...args: Parameters<F>) => string | false = (...args) =>
    JSON.stringify(args),
): F => {
  const cache: Map<string, ReturnType<F>> = new Map();
  return ((...args: Parameters<F>): ReturnType<F> => {
    const k = key(...args);
    if (k) {
      if (cache.has(k)) {
        const v = cache.get(k)!;
        // don't cache failures
        if (!isFailedPromise(v)) return v;
      }
      const v = f(...args);
      cache.set(k, v);
      return v;
    } else {
      // if k is falsey, skip the cache
      return f(...args);
    }
  }) as F;
};
