// Deduplicate CONCURRENT calls only: the entry is dropped once the promise
// settles, so nothing stale or unbounded accumulates in memory. Use where a
// durable cache (the DB) already serves repeat calls and the only job left
// for a memo is stopping two in-flight duplicates.
export const coalesce = <F extends (...args: any[]) => Promise<any>>(
  f: F,
  key: (...args: Parameters<F>) => string | false,
): F & { cache: Map<string, Promise<any>> } => {
  const cache = new Map<string, Promise<any>>();
  const wrapped = ((...args: Parameters<F>) => {
    const k = key(...args);
    if (!k) return f(...args); // a falsey key skips coalescing
    const inFlight = cache.get(k);
    if (inFlight) return inFlight;
    const p = f(...args);
    cache.set(k, p);
    // the .catch keeps the finally's derived promise from becoming an
    // unhandled rejection; callers still see `p` reject normally
    p.finally(() => cache.delete(k)).catch(() => {});
    return p;
  }) as F & { cache: Map<string, Promise<any>> };
  wrapped.cache = cache;
  return wrapped;
};

// The Telegram error description of a failed API call, or '' (deliberately
// NOT falling back to e.message: wording checks against it must never match
// text from a synthetic or network error). log-message's errDesc is the
// looser variant for human-facing logging.
export const telegramDesc = (e: unknown): string =>
  String((e as any)?.response?.description ?? '');

// A keyed mutex: operations that share a key take turns; different keys run
// concurrently. In-memory only, for races between in-process operations.
export const keyedLock = () => {
  const locks = new Map<string, Promise<void>>();
  return async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    // the has-check and the set below are synchronous (no await between
    // them), so at most one waiter ever exits the loop and claims the key
    // before re-blocking
    while (locks.has(key)) await locks.get(key);
    let release!: () => void;
    locks.set(key, new Promise<void>((r) => (release = r)));
    try {
      return await fn();
    } finally {
      locks.delete(key);
      release();
    }
  };
};

export const limit = <F extends (...args: any[]) => Promise<any>>(
  n: number,
  f: F,
): F => {
  let running = 0;
  const waiters: (() => void)[] = [];
  return (async (...args: Parameters<F>) => {
    if (running >= n) {
      // the releaser hands its slot over, so running stays unchanged:
      // decrementing first would let a new arrival sneak past the cap
      await new Promise<void>((next) => waiters.push(next));
    } else {
      running++;
    }
    try {
      return await f(...args);
    } finally {
      const next = waiters.shift();
      if (next) next();
      else running--;
    }
  }) as F;
};
