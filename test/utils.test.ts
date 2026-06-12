import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  mock,
  spyOn,
} from 'bun:test';
import { isFailedPromise, limit, memoize } from '../src/utils';

beforeEach(() => jest.clearAllMocks());
afterAll(() => mock.restore());

describe('isFailedPromise', () => {
  it('returns true for rejected promises', async () => {
    const failed = Promise.reject(new Error('fail'));
    expect(failed).rejects.toThrowError();
    expect(isFailedPromise(failed)).toBe(true);
  });

  it('returns false for everything else', () => {
    expect(isFailedPromise(Promise.resolve(42))).toBe(false);
    expect(isFailedPromise(new Promise((_) => {}))).toBe(false);
    expect(isFailedPromise(42)).toBe(false);
  });
});

describe('memoize', () => {
  it('caches results by default key', () => {
    const fn = mock((x: number) => x + 1);
    const m = memoize(fn);
    expect(m(1)).toBe(2);
    expect(m(1)).toBe(2);
    expect(fn).toHaveBeenCalledTimes(1); // Only called once due to cache
  });

  it('uses custom key function', () => {
    const fn = mock((x: number, y: number) => x + y);
    const m = memoize(fn, (x, y) => `${x}-${y}`);
    expect(m(1, 2)).toBe(3);
    expect(m(1, 2)).toBe(3);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('skips cache if key returns false', () => {
    const fn = mock((x: number) => x * 2);
    const m = memoize(fn, () => false);
    expect(m(2)).toBe(4);
    expect(m(2)).toBe(4);
    expect(fn).toHaveBeenCalledTimes(2); // Not cached
  });

  it('does not cache failed results', () => {
    // Simulate Bun.peek returning Error for failed result
    // @ts-ignore
    spyOn(Bun, 'peek').mockImplementation((x: any) =>
      x instanceof Error ? x : undefined,
    );
    const fn = mock((x: number) => {
      if (x === 0) return new Error('fail');
      return x;
    });
    const m = memoize(fn);
    expect(m(0)).toBeInstanceOf(Error);
    expect(m(0)).toBeInstanceOf(Error);
    expect(fn).toHaveBeenCalledTimes(2); // Should not cache errors
  });

  it('exposes the cache Map', () => {
    const fn = (x: number) => x + 1;
    const m = memoize(fn);
    m(5);
    expect(m.cache.size).toBe(1);
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
    expect(started).toEqual([0, 1]); // third waits

    finishers[0]!();
    await Bun.sleep(10);
    expect(started).toEqual([0, 1, 2]);

    finishers[1]!();
    finishers[2]!();
    await Bun.sleep(10);
    finishers[3]!();
    expect(await results).toEqual([0, 1, 2, 3]);
  });

  it('releases the slot when the function throws', async () => {
    const f = limit(1, async (fail: boolean) => {
      if (fail) throw new Error('boom');
      return 'ok';
    });
    expect(f(true)).rejects.toThrow('boom');
    expect(await f(false)).toBe('ok'); // slot was released
  });
});
