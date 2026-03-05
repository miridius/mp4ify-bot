import { beforeEach, describe, expect, it } from 'bun:test';
import {
  addPending,
  clearPending,
  getPending,
  takePending,
  type PendingDownload,
} from '../src/pending-downloads';

const makePending = (overrides: Partial<PendingDownload> = {}) =>
  ({
    info: { webpage_url: 'https://example.com' },
    verbose: false,
    messageId: 1,
    chatId: -100,
    userId: 123,
    postDownload: false,
    ...overrides,
  }) satisfies PendingDownload;

beforeEach(() => clearPending());

describe('pending-downloads', () => {
  it('addPending returns a unique id and getPending retrieves it', async () => {
    const entry = makePending();
    const id = await addPending(entry);
    expect(id).toBeString();
    const retrieved = await getPending(id);
    expect(retrieved).toEqual(entry);
  });

  it('takePending removes the entry', async () => {
    const id = await addPending(makePending());
    expect(await takePending(id)).toBeDefined();
    expect(await takePending(id)).toBeUndefined();
    expect(await getPending(id)).toBeUndefined();
  });

  it('getPending returns undefined for nonexistent id', async () => {
    expect(await getPending('nonexistent')).toBeUndefined();
  });

  it('persists across reads (file-based)', async () => {
    const entry = makePending({ userId: 456 });
    const id = await addPending(entry);
    // Re-read should still find it
    const retrieved = await getPending(id);
    expect(retrieved?.userId).toBe(456);
  });
});
