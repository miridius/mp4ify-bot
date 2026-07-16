import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  mock,
} from 'bun:test';
import { coalesce, limit } from '../src/utils';

beforeEach(() => jest.clearAllMocks());
afterAll(() => mock.restore());

describe('coalesce', () => {
  it('dedupes concurrent calls, then evicts once settled', async () => {
    let release!: (v: string) => void;
    const fn = mock(() => new Promise<string>((r) => (release = r)));
    const c = coalesce(fn, (k: string) => k);

    const p1 = c('a');
    const p2 = c('a'); // in-flight → same promise, no second call
    expect(p2).toBe(p1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(c.cache.size).toBe(1);

    release('done');
    expect(await p1).toBe('done');
    await Bun.sleep(0); // let the settle-eviction microtask run
    expect(c.cache.size).toBe(0);

    // a repeat call after settle re-runs (the durable cache serves it in prod)
    const p3 = c('a');
    expect(fn).toHaveBeenCalledTimes(2);
    release('again');
    expect(await p3).toBe('again');
  });

  it('evicts on rejection too, and the caller still sees the error', async () => {
    const fn = mock(async () => {
      throw new Error('boom');
    });
    const c = coalesce(fn, (k: string) => k);
    await expect(c('a')).rejects.toThrow('boom');
    await Bun.sleep(0);
    expect(c.cache.size).toBe(0);
  });

  it('skips coalescing on a falsey key', async () => {
    const fn = mock(async (x: number) => x);
    const c = coalesce(fn, () => false);
    await Promise.all([c(1), c(1)]);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('limit', () => {
  it('caps in-flight invocations and runs waiters FIFO', async () => {
    const finishers: (() => void)[] = [];
    const started: number[] = [];
    const f = limit(2, async (i: number) => {
      started.push(i);
      await new Promise<void>((r) => finishers.push(r));
      return i;
    });

    const results = Promise.all([f(0), f(1), f(2), f(3)]);
    await Bun.sleep(10);
    expect(started).toEqual([0, 1]);

    finishers[0]!();
    await Bun.sleep(10);
    expect(started).toEqual([0, 1, 2]);

    finishers[1]!();
    finishers[2]!();
    await Bun.sleep(10);
    finishers[3]!();
    expect(await results).toEqual([0, 1, 2, 3]);
  });

  it('hands the slot to the waiter atomically (no over-admission)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let created = 0;
    const finishers: (() => void)[] = [];
    const f = limit(1, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const i = created++;
      await new Promise<void>((r) => (finishers[i] = r));
      inFlight--;
    });
    const p1 = f();
    const p2 = f(); // waiter
    await Bun.sleep(5);
    finishers[0]!();
    // a microtask-scheduled arrival lands between the releaser's bookkeeping
    // and the waiter's resumption, the window where a non-atomic handoff
    // admits a second runner
    const p3 = Promise.resolve().then(() => f());
    await Bun.sleep(20);
    finishers[1]?.();
    await Bun.sleep(20);
    finishers[2]?.();
    await Promise.all([p1, p2, p3]);
    expect(maxInFlight).toBe(1);
  });

  it('releases the slot when the function throws', async () => {
    const f = limit(1, async (fail: boolean) => {
      if (fail) throw new Error('boom');
      return 'ok';
    });
    await expect(f(true)).rejects.toThrow('boom');
    expect(await f(false)).toBe('ok'); // slot was released
  });
});
