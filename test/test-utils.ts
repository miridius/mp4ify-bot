import { mock, spyOn } from 'bun:test';

export const spyMock: typeof spyOn = (obj, k) =>
  spyOn(obj, k).mockImplementation(mock() as any);

spyMock(console, 'debug'); // suppress debug logs

/**
 * Sleeps until `fn()` returns truthy or `timeout` millis (default: 4000) have elapsed.
 */
export const waitUntil = async (fn: () => any, timeout = 4000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end && !fn()) await Bun.sleep(100);
};
