// These tests run against the real filesystem and real child processes:
// test/bin/ contains stub yt-dlp/ffprobe executables driven by control files
// in /tmp/stub (Bun.spawn snapshots the env at startup, so env vars can't
// reach the child). Only the Telegram client (an unowned boundary) is mocked.
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
import { mkdir, readlink, rm, symlink, truncate } from 'fs/promises';
import {
  downloadVideo,
  getInfo,
  probeDuration,
  sendInfo,
  sendVideo,
  updateYtdlp,
} from '../src/download-video';

const INFO_CACHE_DIR = '/storage/_video-info/';
const VIDEO_DIR = '/storage/test-videos/';

// control files for the test/bin stub executables (on PATH via Dockerfile.dev)
const STUB_DIR = '/tmp/stub';
const stub = (files: Record<string, string>) =>
  Promise.all(
    Object.entries(files).map(([k, v]) => Bun.write(`${STUB_DIR}/${k}`, v)),
  );
const stubArgs = async () =>
  (await Bun.file(`${STUB_DIR}/args`).text().catch(() => '')).trim();

afterAll(async () => {
  await rm(STUB_DIR, { recursive: true, force: true });
  mock.restore();
});

// mirrors filenamify in src/download-video.ts
const filenamify = (s: string) =>
  new Bun.CryptoHasher('sha256')
    .update(s)
    .digest('base64')
    .slice(0, -1)
    .replaceAll('/', '_');
const cachePath = (url: string) => INFO_CACHE_DIR + filenamify(url);

beforeEach(async () => {
  jest.clearAllMocks();
  getInfo.cache.clear();
  downloadVideo.cache.clear();
  sendVideo.cache.clear();
  await rm(STUB_DIR, { recursive: true, force: true });
  await mkdir(STUB_DIR, { recursive: true });
  await rm(VIDEO_DIR, { recursive: true, force: true });
  await mkdir(VIDEO_DIR, { recursive: true });
});

// Mocks (Telegram boundary + log observer)
const mockAppend = mock();
const appendedText = () => mockAppend.mock.calls.map(([s]) => s).join('\n');
const mockFlush = mock();
const log = { append: mockAppend, flush: mockFlush };

const mockSendVideo = mock();
const telegram = {
  sendVideo: mockSendVideo.mockResolvedValue({ video: { file_id: 'id' } }),
};
const ctx = { me: 'bot', telegram };

const VideoInfo = {
  filename: `${VIDEO_DIR}file.mp4`,
  title: 'Test',
  webpage_url: 'url',
  duration: 10,
  width: 100,
  height: 100,
};

describe('updateYtdlp', () => {
  const consoleLog = spyOn(console, 'log').mockImplementation(mock());
  const consoleError = spyOn(console, 'error').mockImplementation(mock());

  it('runs yt-dlp --update and logs the result', async () => {
    await stub({ stdout: 'yt-dlp is up to date' });

    await updateYtdlp();

    expect(await stubArgs()).toEndWith('yt-dlp --update');
    expect(consoleLog).toHaveBeenCalledWith(
      'yt-dlp self-update:',
      'yt-dlp is up to date',
    );
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('logs but does not throw when the update fails', async () => {
    await stub({ exit: '1', stderr: 'no permission' });

    await updateYtdlp();

    expect(consoleError).toHaveBeenCalledWith(
      'yt-dlp self-update failed (exit code 1): no permission',
    );
  });

  it('does not throw when spawning fails entirely', async () => {
    // the one boundary file control can't reach: the spawn API itself failing
    spyOn(Bun, 'spawn').mockImplementationOnce(() => {
      throw new Error('ENOENT');
    });
    await updateYtdlp();
    expect(consoleError).toHaveBeenCalledWith(
      'yt-dlp self-update failed:',
      expect.anything(),
    );
  });
});

describe('probeDuration', () => {
  it('returns the rounded duration from ffprobe', async () => {
    await stub({ stdout: '12.62\n' });
    expect(await probeDuration('file.mp4')).toBe(13);
    expect(await stubArgs()).toContain('ffprobe');
    expect(await stubArgs()).toEndWith('file.mp4');
  });

  it('returns undefined and logs when ffprobe fails', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(mock());
    await stub({ exit: '1', stderr: 'corrupt file' });

    expect(await probeDuration('file.mp4')).toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      'ffprobe failed for file.mp4 (exit 1): corrupt file',
    );
  });

  it('returns undefined for unparseable output', async () => {
    await stub({ stdout: 'not a number' });
    expect(await probeDuration('file.mp4')).toBeUndefined();
  });
});

describe('getInfo', () => {
  const url = 'https://test.invalid/getinfo';
  const urlInfo = { ...VideoInfo, webpage_url: url };
  const infoStr = JSON.stringify(urlInfo);

  beforeEach(async () => {
    await rm(cachePath(url), { force: true });
    await stub({ stdout: infoStr });
  });

  it('returns cached info if file exists', async () => {
    await Bun.write(cachePath(url), JSON.stringify({ filename: 'cached.mp4' }));

    const info = await getInfo(log as any, url);

    expect(info.filename).toBe('cached.mp4');
    expect(await stubArgs()).toBe(''); // no scrape
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('fetches info if not cached and writes the cache file', async () => {
    const info = await getInfo(log as any, url);

    expect(info).toEqual(urlInfo);
    expect(appendedText()).toBe(`🧐 <b>Scraping</b> ${url}...`);
    expect(await stubArgs()).toEndWith(
      `yt-dlp ${url} --no-warnings --dump-json`,
    );
    expect(await Bun.file(cachePath(url)).json()).toEqual(urlInfo);
  });

  it('discards a corrupt cache entry, re-scrapes, and rewrites the file', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(mock());
    await Bun.write(cachePath(url), '{ corrupt');

    const info = await getInfo(log as any, url);

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('Discarding corrupt info cache'),
      expect.any(SyntaxError),
    );
    expect(info).toEqual(urlInfo);
    // the file must be restored: downloadVideo loads it via --load-info-json
    expect(await Bun.file(cachePath(url)).json()).toEqual(urlInfo);
  });

  it('discards both the symlink and its corrupt target', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(mock());
    const canon = 'https://test.invalid/getinfo-canon';
    await rm(cachePath(canon), { force: true });
    await Bun.write(cachePath(canon), '{ corrupt');
    await symlink(filenamify(canon), cachePath(url));
    const canonInfo = { ...VideoInfo, webpage_url: canon };
    await stub({ stdout: JSON.stringify(canonInfo) });

    const info = await getInfo(log as any, url);

    expect(info.webpage_url).toBe(canon);
    expect(consoleError).not.toHaveBeenCalledWith(
      'Failed to delete corrupt cache file:',
      expect.anything(),
    );
    // both recreated: target with the fresh scrape, entry as symlink to it
    expect(await Bun.file(cachePath(canon)).json()).toEqual(canonInfo);
    expect(await readlink(cachePath(url))).toBe(filenamify(canon));
  });

  it('handles canonical urls', async () => {
    const canon = 'https://test.invalid/canonical';
    await rm(cachePath(canon), { force: true });
    const canonInfo = { ...VideoInfo, webpage_url: canon };
    await stub({ stdout: JSON.stringify(canonInfo) });

    const info = await getInfo(log as any, url);

    expect(info.webpage_url).toBe(canon);
    expect(await Bun.file(cachePath(canon)).json()).toEqual(canonInfo);
    expect(await readlink(cachePath(url))).toBe(filenamify(canon));
  });

  it('tolerates a dangling sibling symlink (EEXIST)', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(mock());
    const canon = 'https://test.invalid/eexist-canon';
    await rm(cachePath(canon), { force: true });
    await symlink(filenamify(canon), cachePath(url)); // dangling
    const canonInfo = { ...VideoInfo, webpage_url: canon };
    await stub({ stdout: JSON.stringify(canonInfo) });

    const info = await getInfo(log as any, url);

    expect(info.webpage_url).toBe(canon);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('returns scraped info even when the cache write fails', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(mock());
    const canon = 'https://test.invalid/write-fails';
    // a directory at the target path makes the real write fail with EISDIR
    await rm(cachePath(canon), { recursive: true, force: true });
    await mkdir(cachePath(canon));
    const canonInfo = { ...VideoInfo, webpage_url: canon };
    await stub({ stdout: JSON.stringify(canonInfo) });
    try {
      const info = await getInfo(log as any, url);
      expect(info.webpage_url).toBe(canon);
      expect(consoleError).toHaveBeenCalledWith(
        'Failed to write info cache:',
        expect.anything(),
      );
    } finally {
      await rm(cachePath(canon), { recursive: true, force: true });
    }
  });
});

describe('sendInfo', () => {
  it('logs video info', async () => {
    await sendInfo(log as any, VideoInfo);
    expect(appendedText()).toBe(
      `
🎬 <b>Video info:</b>

<b>URL</b>: url
<b>filename</b>: file.mp4
<b>duration</b>: 10 sec
<b>resolution</b>: 100x100`,
    );
  });

  it('logs formats', async () => {
    const consoleTable = spyOn(console, 'table').mockImplementation(mock());
    const infoWithFormats = {
      ...VideoInfo,
      formats: [
        { format: 'best', ext: 'mp4', vcodec: 'h264', acodec: 'aac', tbr: 1 },
      ],
    };
    await sendInfo(log as any, infoWithFormats as any);
    expect(consoleTable).toHaveBeenCalled();
  });

  it.each([
    { resolution: '1920x1080', expected: '1920x1080' },
    { height: 1080, width: 0, expected: '1080p' },
    { height: 0, width: 0, format_id: 'hd', expected: 'HD' },
  ])('parses %j', async ({ expected, ...res }) => {
    await sendInfo(log as any, { ...VideoInfo, ...res } as any);
    expect(appendedText()).toContain(`<b>resolution</b>: ${expected}`);
  });

  it('calculates duration without sponsors', async () => {
    const infoWithSponsors = {
      ...VideoInfo,
      duration: 100,
      sponsorblock_chapters: [
        { start_time: 0, end_time: 25, category: 'sponsor', type: 'skip' },
      ],
    };
    await sendInfo(log as any, infoWithSponsors as any);
    expect(appendedText()).toContain(
      '<b>duration</b>: 75 sec (100s before removing sponsors)',
    );
  });
});

describe('downloadVideo', () => {
  const infoPath = cachePath(VideoInfo.webpage_url);

  it.each([
    { signal: 'TERM', message: 'Timed out after 300 seconds' },
    { signal: 'KILL', message: 'yt-dlp was killed with signal SIGKILL' },
    { exit: '1', message: 'yt-dlp exited with code 1' },
  ])('error messages for failures: %j', async ({ signal, exit, message }) => {
    if (signal) await stub({ signal });
    if (exit) await stub({ exit });
    await expect(
      downloadVideo(ctx as any, log as any, VideoInfo),
    ).rejects.toThrow(message);
  });

  it("returns 'already downloaded' if id file exists", async () => {
    await Bun.write(`${VideoInfo.filename}.bot.id`, 'file-id');
    expect(await downloadVideo(ctx as any, log as any, VideoInfo)).toBe(
      'already downloaded',
    );
    expect(await stubArgs()).toBe('');
  });

  it("returns 'already downloaded' if video file exists", async () => {
    await Bun.write(VideoInfo.filename, 'video bytes');
    expect(await downloadVideo(ctx as any, log as any, VideoInfo)).toBe(
      'already downloaded',
    );
    expect(await stubArgs()).toBe('');
  });

  it('calls yt-dlp with the cached info file if not downloaded', async () => {
    await stub({ stdout: 'downloaded ok' });
    expect(await downloadVideo(ctx as any, log as any, VideoInfo)).toBe(
      'downloaded ok',
    );
    expect(await stubArgs()).toEndWith(
      `yt-dlp  --no-warnings --load-info-json ${infoPath}`,
    );
    expect(appendedText()).toContain('⬇️ <b>Downloading...</b>');
  });

  it('logs stderr as it streams', async () => {
    await stub({ stderr: 'progress line' });
    await downloadVideo(ctx as any, log as any, VideoInfo);
    expect(appendedText()).toContain('<code>progress line</code>');
  });
});

describe('sendVideo', () => {
  const idFile = `${VideoInfo.filename}.bot.id`;

  it('uploads the video, stores the file_id, and deletes the upload', async () => {
    await Bun.write(VideoInfo.filename, 'video bytes');

    const msg = await sendVideo(ctx as any, log as any, VideoInfo, 123);

    expect(mockSendVideo).toHaveBeenCalledWith(
      123,
      Bun.pathToFileURL(VideoInfo.filename).href,
      expect.objectContaining({ width: 100, height: 100, duration: 10 }),
    );
    expect(msg!.video.file_id).toBe('id');
    expect(await Bun.file(idFile).text()).toBe('id');
    expect(await Bun.file(VideoInfo.filename).exists()).toBe(false);
  });

  it('resends by file_id without touching the video file', async () => {
    await Bun.write(idFile, 'cached-file-id');

    await sendVideo(ctx as any, log as any, VideoInfo, 123);

    expect(mockSendVideo).toHaveBeenCalledWith(
      123,
      'cached-file-id',
      expect.anything(),
    );
  });

  it('returns undefined if video too large', async () => {
    await Bun.write(VideoInfo.filename, ''); // allocate, then grow sparsely
    await truncate(VideoInfo.filename, 2001 * 1024 * 1024);

    expect(
      await sendVideo(ctx as any, log as any, VideoInfo, 123),
    ).toBeUndefined();
    expect(appendedText()).toContain('😞 Video too large (2001.00 MB)');
    expect(mockSendVideo).not.toHaveBeenCalled();
  });

  it('throws if video file not found', async () => {
    await expect(
      sendVideo(ctx as any, log as any, VideoInfo, 123),
    ).rejects.toThrow('yt-dlp output file not found');
  });

  it('sends the video as a reply message if requested', async () => {
    await Bun.write(VideoInfo.filename, 'video bytes');

    await sendVideo(ctx as any, log as any, VideoInfo, 123, 42);

    expect(mockSendVideo).toHaveBeenCalledWith(
      123,
      expect.anything(),
      expect.objectContaining({
        reply_parameters: { message_id: 42 },
        reply_to_message_id: 42,
      }),
    );
  });
});
