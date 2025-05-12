export const memoize = <F extends (...args: any[]) => any>(
  f: F,
  key: (...args: Parameters<F>) => string = (...args) => JSON.stringify(args),
): F => {
  const cache: Map<string, ReturnType<F>> = new Map();
  return ((...args: Parameters<F>): ReturnType<F> => {
    const k = key(...args);
    if (cache.has(k)) {
      return cache.get(k)!;
    } else {
      const v = f(...args);
      cache.set(k, v);
      return v;
    }
  }) as F;
};
