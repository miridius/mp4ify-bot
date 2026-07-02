import { beforeEach, describe, expect, it } from 'bun:test';
import { getBlob, recordBlob, withBlobLock } from '../src/blob-store';
import { db, resetDb } from '../src/db';
import {
  addPending,
  getPending,
  PENDING_TTL_MS,
  sweepStalePending,
  takePending,
  type PendingDownload,
} from '../src/pending-downloads';

// addPending stamps kind: 'confirmed' on write, so the parked pending row is a
// ready-to-run confirmed job plus the requester id
const makePending = (overrides: Partial<PendingDownload> = {}) =>
  ({
    info: { webpage_url: 'https://example.com' },
    verbose: false,
    messageId: 1,
    chatId: -100,
    userId: 123,
    postDownload: false,
    ...overrides,
  }) satisfies Omit<PendingDownload, 'kind'>;

beforeEach(() => resetDb());

describe('pending-downloads', () => {
  it('addPending returns a unique id and getPending retrieves it', async () => {
    const entry = makePending();
    const id = await addPending(entry);
    expect(id).toBeString();
    const retrieved = await getPending(id);
    expect(retrieved).toEqual({ kind: 'confirmed', ...entry });
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

describe('sweepStalePending', () => {
  beforeEach(() => resetDb());

  const age = (id: string, ms: number) =>
    db
      .query('UPDATE pending SET created_at = ? WHERE id = ?')
      .run(Date.now() - ms, id);

  const mkInfo = (id: string) =>
    ({
      filename: `/x-${id}.mp4`,
      title: 'T',
      webpage_url: `https://x/${id}`,
      extractor: 'test',
      id,
    }) as any;

  it('drops abandoned rows and releases the blob a postDownload one pinned', async () => {
    const info = mkInfo('sweepme');
    recordBlob(info);
    const id = await addPending(makePending({ info, postDownload: true }));
    age(id, PENDING_TTL_MS + 1000);

    await sweepStalePending();

    expect(await getPending(id)).toBeUndefined(); // the prompt is dead
    expect(getBlob(info)).toBeNull(); // and the bytes it pinned are released
  });

  it('leaves fresh rows (and their blobs) alone', async () => {
    const id = await addPending(makePending({ postDownload: false }));
    await sweepStalePending();
    expect(await getPending(id)).toBeDefined();
  });

  it('skips a row claimed mid-sweep instead of releasing its blob', async () => {
    // The sweep awaits inside each row's release, so a later row can be
    // claimed (confirm/cancel) after the sweep snapshotted it: its delete is
    // then a no-op and the blob the claimant now owns must NOT be released.
    // Hold row A's blob lock to park the sweep in that window, then take B.
    const [infoA, infoB] = [mkInfo('a'), mkInfo('b')];
    recordBlob(infoA);
    recordBlob(infoB);
    // insertion order drives the sweep's row order (full-table scan): A first
    const idA = await addPending(makePending({ info: infoA, postDownload: true }));
    const idB = await addPending(makePending({ info: infoB, postDownload: true }));
    age(idA, PENDING_TTL_MS + 1000);
    age(idB, PENDING_TTL_MS + 1000);

    let unblock!: () => void;
    const held = new Promise<void>((r) => (unblock = r));
    const holding = withBlobLock(infoA, () => held);
    const sweep = sweepStalePending(); // parks on A's blob lock
    await Bun.sleep(10);
    expect(await takePending(idB)).toBeDefined(); // B claimed mid-sweep
    unblock();
    await Promise.all([holding, sweep]);

    expect(getBlob(infoA)).toBeNull(); // A released normally
    expect(getBlob(infoB)).not.toBeNull(); // B's blob survives for its claimant
  });
});
