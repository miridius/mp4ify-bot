// Unlike download-video.test.ts, these tests use the real filesystem and a
// real BunFile: the corrupt-cache recovery bug they pin (stale exists() on a
// read BunFile) is invisible when Bun.file is mocked.
import { afterAll, beforeEach, expect, it, jest, mock, spyOn } from 'bun:test';
import { getInfo } from '../src/download-video';

beforeEach(() => {
  jest.clearAllMocks();
  getInfo.cache.clear();
});
afterAll(() => mock.restore());

const log = { append: mock(), flush: mock() };

const url = 'https://integration.test/corrupt-cache';
// mirrors filenamify in src/download-video.ts
const cachePath =
  '/storage/_video-info/' +
  new Bun.CryptoHasher('sha256')
    .update(url)
    .digest('base64')
    .slice(0, -1)
    .replaceAll('/', '_');
const info = { filename: 'f.mp4', title: 't', webpage_url: url };

const mockSpawn = spyOn(Bun, 'spawn').mockImplementation(
  () =>
    ({
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(info)));
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
      exitCode: 0,
      exited: Promise.resolve(),
    }) as any,
);

it('rewrites the cache file after discarding a corrupt entry', async () => {
  spyOn(console, 'error').mockImplementation(mock());
  await Bun.write(cachePath, '{ corrupt');

  expect(await getInfo(log as any, url)).toEqual(info);

  // the file must be restored: downloadVideo loads it via --load-info-json
  expect(await Bun.file(cachePath).json()).toEqual(info);
  expect(mockSpawn).toHaveBeenCalledTimes(1);
});

it('round-trips a cache miss then a cache hit on the real fs', async () => {
  await Bun.file(cachePath)
    .unlink()
    .catch(() => {});

  expect(await getInfo(log as any, url)).toEqual(info);
  getInfo.cache.clear();
  expect(await getInfo(log as any, url)).toEqual(info);
  expect(mockSpawn).toHaveBeenCalledTimes(1); // second call served from disk
});
