import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  setSystemTime,
} from 'bun:test';
import { memoize, spyMock, waitUntil } from './test-utils';

afterAll(() => mock.restore());

describe('waitUntil', () => {
  beforeEach(() => setSystemTime(0));
  spyMock(Bun, 'sleep').mockImplementation((ms) =>
    Promise.resolve(setSystemTime(Date.now() + (ms as number)) && undefined),
  );

  it('waits and polls until fn returns true', async () => {
    await waitUntil(() => Date.now() === 200, 500);
    expect(Date.now()).toBe(200);
  });

  it('times out if fn never returns true', async () => {
    await waitUntil(() => false, 300);
    expect(Date.now()).toBe(300);
  });
});

describe('memoize', () => {
  it('caches results by default key', () => {
    const fn = mock((x: number) => x + 1);
    const m = memoize(fn);
    expect(m(1)).toBe(2);
    expect(m(1)).toBe(2);
    expect(fn).toHaveBeenCalledTimes(1);
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
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('exposes the cache Map', () => {
    const fn = (x: number) => x + 1;
    const m = memoize(fn);
    m(5);
    expect(m.cache.size).toBe(1);
  });
});
