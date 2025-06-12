import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  setSystemTime,
} from 'bun:test';
import { spyMock, waitUntil } from './test-utils';

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
