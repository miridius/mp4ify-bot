// Real DB + real filesystem: the blob store is ours, so nothing here is mocked.
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from 'bun:test';
import { mkdir, rm } from 'fs/promises';
import {
  BLOB_TTL_MS,
  blobKey,
  blobPath,
  videoKey,
  getBlob,
  recordBlob,
  releaseBlob,
  setBlobDuration,
  setBlobFileId,
  sweepOrphanBlobs,
  withBlobLock,
} from '../src/blob-store';
import { db, resetDb } from '../src/db';
import { spyMock } from './test-utils';

const info = (overrides: Record<string, unknown> = {}) =>
  ({
    filename: '/storage/test-videos/v.mp4',
    title: 'T',
    extractor: 'yt',
    id: 'abc',
    format_id: '137',
    ext: 'mp4',
    ...overrides,
  }) as any;

beforeEach(async () => {
  resetDb();
  await rm('/storage/blobs', { recursive: true, force: true });
  await mkdir('/storage/blobs', { recursive: true });
});
afterAll(() => mock.restore());

describe('blobKey / blobPath', () => {
  it('addresses by yt-dlp identity, independent of filename/title', () => {
    expect(blobKey(info({ filename: '/a.mp4', title: 'A' }))).toBe(
      blobKey(info({ filename: '/b.mp4', title: 'B' })),
    );
    expect(blobKey(info())).not.toBe(blobKey(info({ format_id: '22' })));
  });

  it('keys a video without its format, so a re-scrape that drifts still matches', () => {
    expect(videoKey(info())).toBe(videoKey(info({ format_id: '22' })));
    expect(blobKey(info())).not.toBe(blobKey(info({ format_id: '22' })));
  });

  it('separates two identity-less videos of one page by title', () => {
    const page = (title: string, format_id: string) =>
      info({
        extractor: 'generic',
        id: 'master',
        title,
        format_id,
        filename: `/x/${title}.${format_id}.mp4`,
        webpage_url: 'https://p',
      });
    expect(videoKey(page('Clip (1)', 'a'))).not.toBe(
      videoKey(page('Clip (2)', 'a')),
    );
    expect(videoKey(page('Clip (1)', 'a'))).toBe(videoKey(page('Clip (1)', 'b')));
  });

  it('separates same-titled identity-less videos by their ids', () => {
    const clip = (id: string) =>
      info({ extractor: 'generic', id, title: 'Clip', webpage_url: 'https://p' });
    expect(videoKey(clip('v1'))).not.toBe(videoKey(clip('v2')));
  });

  it('separates same-titled identity-less videos of different pages', () => {
    const clip = (webpage_url: string) =>
      info({ extractor: 'generic', id: 'master', title: 'Clip', webpage_url });
    expect(videoKey(clip('https://p1'))).not.toBe(videoKey(clip('https://p2')));
  });

  it('falls back to the filename when the identity is missing', () => {
    const i = { filename: '/storage/x/foo.mp4', title: 'T' } as any;
    expect(blobKey(i)).toBe('/storage/x/foo.mp4');
    // the path escapes the key's '/' so it can't act as a directory separator
    expect(blobPath(i)).toBe('/storage/blobs/%2Fstorage%2Fx%2Ffoo.mp4.mp4');
  });

  it('treats the generic extractor as identity-less (URL-salted fallback)', () => {
    // generic's id is just the URL basename (verified against real yt-dlp:
    // two hosts' /video.mp4 both yield id 'video'), so it must not key blobs
    const a = info({
      extractor: 'generic',
      id: 'video',
      webpage_url: 'https://a.example/video.mp4',
    });
    const b = info({
      extractor: 'generic',
      id: 'video',
      webpage_url: 'https://b.example/video.mp4',
    });
    expect(blobKey(a)).not.toBe(blobKey(b));
    expect(blobKey(a)).toBe(blobKey({ ...a }));
  });

  it('salts the filename fallback with the canonical URL', () => {
    // two DIFFERENT videos whose titles collide produce the same yt-dlp
    // filename; without the salt they'd share a key, and the first one's
    // cached file_id would be served for the second video
    const a = { filename: '/x/t.mp4', title: 'T', webpage_url: 'https://a' };
    const b = { filename: '/x/t.mp4', title: 'T', webpage_url: 'https://b' };
    expect(blobKey(a as any)).not.toBe(blobKey(b as any));
    // ...while the same video keeps a stable key
    expect(blobKey(a as any)).toBe(blobKey({ ...a } as any));
  });

  it('escapes a hostile extension so it cannot traverse out of the blob dir', () => {
    // a '/' in ext would otherwise become a path separator (the sidecar write
    // auto-creates parent dirs, planting files outside the store)
    const i = info({ ext: 'mp4/../../tmp/x' });
    expect(blobPath(i)).not.toContain('/../');
    expect(blobPath(i).split('/').length).toBe(
      blobPath(info()).split('/').length,
    );
  });

  it('caps an over-long identity to a bounded, collision-free filename', () => {
    // the differing char is past the truncation point, so only the appended
    // hash tag distinguishes the two files
    const longId = (suffix: string) => info({ id: 'x'.repeat(300) + suffix });
    const pathA = blobPath(longId('A'));
    const name = pathA.slice('/storage/blobs/'.length);
    // the `.json` sidecar is the longest sibling we write; it must fit NAME_MAX
    expect(Buffer.byteLength(`${name}.json`)).toBeLessThanOrEqual(255);
    expect(name.endsWith('.mp4')).toBe(true);
    expect(blobPath(longId('A'))).toBe(pathA);
    expect(blobPath(longId('B'))).not.toBe(pathA);
  });

  it('clamps a pathological extension so the filename stays bounded', () => {
    const name = blobPath(info({ ext: 'x'.repeat(300) })).slice(
      '/storage/blobs/'.length,
    );
    expect(Buffer.byteLength(`${name}.json`)).toBeLessThanOrEqual(255);
  });
});

describe('recordBlob / getBlob / setBlobFileId', () => {
  it('records, reads, and caches a file_id and duration', () => {
    expect(getBlob(info())).toBeNull();
    recordBlob(info());
    expect(getBlob(info())).toEqual({
      path: blobPath(info()),
      file_id: null,
      duration: null,
    });
    setBlobFileId(info(), 'FILEID');
    expect(getBlob(info())?.file_id).toBe('FILEID');
    setBlobDuration(info(), 1234);
    expect(getBlob(info())?.duration).toBe(1234);
  });
});

// a parked confirmation pinning i's blob (the shape addPending writes)
const seedPendingRef = (i: any = info()) =>
  db
    .query(
      'INSERT INTO pending (id, payload, user_id, blob_key, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(crypto.randomUUID(), '{}', 1, blobKey(i), Date.now());

describe('releaseBlob', () => {

  it('unlinks the bytes and drops the row when nothing references it', async () => {
    recordBlob(info());
    await Bun.write(blobPath(info()), 'bytes');

    await releaseBlob(info());

    expect(await Bun.file(blobPath(info())).exists()).toBe(false);
    expect(getBlob(info())).toBeNull();
  });

  it('keeps the bytes while a parked confirmation references it', async () => {
    recordBlob(info());
    await Bun.write(blobPath(info()), 'bytes');
    seedPendingRef();

    await releaseBlob(info());

    expect(await Bun.file(blobPath(info())).exists()).toBe(true);
    expect(getBlob(info())).not.toBeNull();
  });

  it('keeps an uploaded blob (file_id set) as the file_id cache', async () => {
    recordBlob(info());
    setBlobFileId(info(), 'FILEID');

    await releaseBlob(info());

    expect(getBlob(info())?.file_id).toBe('FILEID');
  });

  it('is a no-op when there is no blob row', async () => {
    await expect(releaseBlob(info())).resolves.toBeUndefined();
  });

  it('logs but does not throw when unlinking the bytes fails', async () => {
    recordBlob(info());
    // a real unlink failure (no owned-code spy): the blob path is a directory,
    // so unlink() returns EISDIR instead of removing it
    await mkdir(blobPath(info()));
    const consoleError = spyMock(console, 'error');

    await releaseBlob(info()); // must not reject

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to clean up'),
      expect.any(Error),
    );
    consoleError.mockRestore();
  });
});

describe('withBlobLock', () => {
  it('serializes same-blob operations but lets different blobs run concurrently', async () => {
    const order: string[] = [];
    const op = (i: any, tag: string, holdMs: number) =>
      withBlobLock(i, async () => {
        order.push(`${tag}:start`);
        await Bun.sleep(holdMs);
        order.push(`${tag}:end`);
      });

    const a = op(info(), 'a', 25); // holds the key
    const b = op(info(), 'b', 0); // same key: must wait for a to finish
    const c = op(info({ id: 'other' }), 'c', 0); // different key: concurrent
    await Promise.all([a, b, c]);

    // b cannot start until a has fully released the lock
    expect(order.indexOf('a:end')).toBeLessThan(order.indexOf('b:start'));
    // c is a different blob, so it runs without waiting for a
    expect(order.indexOf('c:start')).toBeLessThan(order.indexOf('a:end'));
  });

  it('releases the lock even when the operation throws', async () => {
    await expect(
      withBlobLock(info(), async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // the key is free again, so a later operation on it still runs
    let ran = false;
    await withBlobLock(info(), async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});

describe('sweepOrphanBlobs', () => {
  // backdate a row just past the reclamation TTL (tied to the production
  // constant, so a TTL change can't quietly make these tests vacuous)
  const ageBlob = (i: any) =>
    db
      .query('UPDATE blobs SET created_at = ? WHERE key = ?')
      .run(Date.now() - BLOB_TTL_MS - 1000, blobKey(i));

  it('removes bytes no live row needs; keeps a pending download', async () => {
    // an orphan (crash between rename and recordBlob): file, no row
    await Bun.write('/storage/blobs/orphan.mp4', 'x');
    // a leaked sidecar (crash beat the download finally)
    await Bun.write('/storage/blobs/leaked.mp4.json', '{}');
    // redundant bytes (crash between setBlobFileId and the unlink)
    recordBlob(info({ id: 'uploaded' }));
    await Bun.write(blobPath(info({ id: 'uploaded' })), 'x');
    setBlobFileId(info({ id: 'uploaded' }), 'fid');
    // a live, not-yet-sent blob must survive
    recordBlob(info({ id: 'live' }));
    await Bun.write(blobPath(info({ id: 'live' })), 'x');
    // a leaked row (its releaser crashed or its key era ended): file_id-null
    // and past the TTL, so the sweep reclaims row and bytes; nothing else can
    const leakedInfo = info({ id: 'leaked-row' });
    recordBlob(leakedInfo);
    await Bun.write(blobPath(leakedInfo), 'x');
    ageBlob(leakedInfo);

    await sweepOrphanBlobs();

    expect(await Bun.file('/storage/blobs/orphan.mp4').exists()).toBe(false);
    expect(await Bun.file('/storage/blobs/leaked.mp4.json').exists()).toBe(false);
    expect(
      await Bun.file(blobPath(info({ id: 'uploaded' }))).exists(),
    ).toBe(false);
    expect(await Bun.file(blobPath(info({ id: 'live' }))).exists()).toBe(true);
    expect(await Bun.file(blobPath(leakedInfo)).exists()).toBe(false);
    expect(getBlob(leakedInfo)).toBeNull();
  });

  it('keeps a stale-aged blob a parked confirmation still pins', async () => {
    const pinned = info({ id: 'pinned-old' });
    recordBlob(pinned);
    await Bun.write(blobPath(pinned), 'x');
    ageBlob(pinned);
    seedPendingRef(pinned);

    await sweepOrphanBlobs();

    expect(getBlob(pinned)).not.toBeNull();
    expect(await Bun.file(blobPath(pinned)).exists()).toBe(true);
  });
});
