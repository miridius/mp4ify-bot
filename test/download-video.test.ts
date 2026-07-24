// These tests run against the real filesystem and real child processes:
// test/bin/ contains stub yt-dlp/ffprobe executables driven by control files
// in /tmp/stub (Bun.spawn snapshots the env at startup, so env vars can't
// reach the child). Only the Telegram client (an unowned boundary) is mocked.
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  mock,
  spyOn,
} from 'bun:test';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  truncate,
} from 'fs/promises';
import {
  blobPath,
  getBlob,
  recordBlob,
  releaseBlob,
  setBlobFileId,
} from '../src/blob-store';
import { STAGING_DIR } from '../src/consts';
import { db, resetDb } from '../src/db';
import { githubMock } from './simulate-bot-api';
import {
  rowCount,
  seedInfoRow,
  spyMock,
  telegramError,
  waitUntil,
  withFailingWrite,
} from './test-utils';
import {
  abortDownloads,
  classifyFailure,
  downloadVideo,
  getInfo,
  isPermanentError,
  liveYtdlpSize,
  probeDuration,
  removeCachedInfo,
  resetShutdown,
  sendInfo,
  sendVideo,
  updateYtdlp,
  YtdlpError,
} from '../src/download-video';

const VIDEO_DIR = '/storage/test-videos/';

// control files for the test/bin stub executables (on PATH via Dockerfile.dev)
const STUB_DIR = '/tmp/stub';
const stub = (files: Record<string, string>) =>
  Promise.all(
    Object.entries(files).map(([k, v]) => Bun.write(`${STUB_DIR}/${k}`, v)),
  );
const stubArgs = async () =>
  (
    await Bun.file(`${STUB_DIR}/args`)
      .text()
      .catch(() => '')
  ).trim();

afterAll(async () => {
  await rm(STUB_DIR, { recursive: true, force: true });
  mock.restore();
});

beforeEach(async () => {
  jest.clearAllMocks();
  resetDb();
  getInfo.cache.clear();
  downloadVideo.cache.clear();
  await rm(STUB_DIR, { recursive: true, force: true });
  await mkdir(STUB_DIR, { recursive: true });
  await rm(VIDEO_DIR, { recursive: true, force: true });
  await mkdir(VIDEO_DIR, { recursive: true });
  await rm('/storage/blobs', { recursive: true, force: true });
  await mkdir('/storage/blobs', { recursive: true });
});

// Mocks (Telegram boundary + log observer)
const mockAppend = mock();
const appendedText = () => mockAppend.mock.calls.map(([s]) => s).join('\n');
const mockFlush = mock();
const log = { append: mockAppend, flush: mockFlush };

const mockSendVideo = mock();
const telegram = {
  sendVideo: mockSendVideo.mockResolvedValue({ video: { file_id: 'id' } }),
} as any;

const VideoInfo = {
  filename: `${VIDEO_DIR}file.mp4`,
  title: 'Test',
  webpage_url: 'url',
  duration: 10,
  width: 100,
  height: 100,
};

describe('updateYtdlp', () => {
  const consoleLog = spyMock(console, 'log');
  const consoleError = spyMock(console, 'error');
  const consoleDebug = spyMock(console, 'debug');

  // updateYtdlp updates a COPY of the on-PATH binary and atomically renames it
  // into place. Point it at an isolated fake we exec for real (not the shared
  // test/bin stub), so the real copy/update/rename can't clobber a binary other
  // suites depend on. Only Bun.which (path resolution) is stubbed.
  let dir: string, bin: string, ctrl: string, whichSpy: any;
  beforeEach(async () => {
    // /storage (not noexec /tmp) so the fake can actually be exec'd
    dir = await mkdtemp('/storage/ytdlp-update-');
    bin = `${dir}/yt-dlp`;
    ctrl = `${dir}/ctrl`;
    await mkdir(ctrl);
    // a real yt-dlp stand-in: records args, emits controlled stdout/stderr/exit,
    // and on `new` simulates a downloaded release by overwriting its own $0 in
    // place (preserving mode), exactly like yt-dlp's zip-variant --update. The
    // body is a function so the shell parses it whole before the self-overwrite.
    await Bun.write(
      bin,
      [
        '#!/bin/sh',
        // the pre-check reads --version before deciding to update; default to a
        // version that never matches the githubMock tag so tests exercise the
        // full update path unless they set ctrl/version explicitly
        // vreads records each spawn so the mtime-keyed version cache is pinned
        `[ "$1" = "--version" ] && { echo v >> "${ctrl}/vreads"; cat "${ctrl}/version" 2>/dev/null || echo 0.0.0; exit 0; }`,
        'run() {',
        `  echo "$0 $*" >> "${ctrl}/args"`,
        `  [ -f "${ctrl}/stderr" ] && cat "${ctrl}/stderr" >&2`,
        `  [ -f "${ctrl}/stdout" ] && cat "${ctrl}/stdout"`,
        `  [ -f "${ctrl}/new" ] && cat "${ctrl}/new" > "$0"`,
        `  exit "$(cat "${ctrl}/exit" 2>/dev/null || echo 0)"`,
        '}',
        'run "$@"',
        '',
      ].join('\n'),
    );
    await chmod(bin, 0o777);
    whichSpy = spyOn(Bun, 'which').mockReturnValue(bin);
  });
  afterEach(async () => {
    whichSpy.mockRestore();
    await rm(dir, { recursive: true, force: true });
  });

  const leftoverTemps = async () =>
    (await readdir(dir)).filter((f) => f.endsWith('.new'));

  it('updates a copy and atomically swaps it in when a new version lands', async () => {
    await Bun.write(`${ctrl}/new`, '#!/bin/sh\necho NEW\n'); // the "download"
    await Bun.write(`${ctrl}/stdout`, 'Updated yt-dlp to 2999.12.31');

    await updateYtdlp();

    expect(await Bun.file(bin).text()).toBe('#!/bin/sh\necho NEW\n');
    expect((await stat(bin)).mode & 0o111).toBeGreaterThan(0);
    expect(consoleLog).toHaveBeenCalledWith(
      'yt-dlp self-update:',
      'Updated yt-dlp to 2999.12.31',
    );
    expect(await leftoverTemps()).toEqual([]);
  });

  it('caches the version read while the binary is unchanged', async () => {
    // spawning the ~35MB zipapp every 5-minute tick just to re-read an
    // unchanged version wastes CPU; the cache keys on the binary's mtime
    await Bun.write(`${ctrl}/version`, 'TEST-LATEST'); // matches githubMock

    await updateYtdlp();
    await updateYtdlp();

    const reads = (await Bun.file(`${ctrl}/vreads`).text()).trim().split('\n');
    expect(reads).toHaveLength(1); // second tick served from the cache
    expect(consoleDebug).toHaveBeenCalledWith('yt-dlp already up to date');
  });

  it('swaps when stdout says "up to date" but the binary actually changed', async () => {
    // a reworded success line that still contains "up to date", but the copy
    // moved: the stat guard must swap anyway so a real update isn't dropped
    await Bun.write(`${ctrl}/new`, '#!/bin/sh\necho NEWER\n');
    await Bun.write(`${ctrl}/stdout`, 'Updated; now up to date (2999.12.31)');

    await updateYtdlp();

    expect(await Bun.file(bin).text()).toBe('#!/bin/sh\necho NEWER\n'); // swapped
    expect(await leftoverTemps()).toEqual([]);
  });

  it('does not swap (just logs) when already up to date', async () => {
    await Bun.write(`${ctrl}/stdout`, 'yt-dlp is up to date');
    const before = await Bun.file(bin).text();

    await updateYtdlp();

    expect(await Bun.file(bin).text()).toBe(before);
    expect(consoleDebug).toHaveBeenCalledWith('yt-dlp already up to date');
    expect(consoleLog).not.toHaveBeenCalled();
    expect(await leftoverTemps()).toEqual([]);
  });

  it('logs, does not throw, and does not swap when the update errors', async () => {
    await Bun.write(`${ctrl}/exit`, '1');
    await Bun.write(`${ctrl}/stderr`, 'no permission');
    const before = await Bun.file(bin).text();

    await updateYtdlp();

    expect(consoleError).toHaveBeenCalledWith(
      'yt-dlp self-update failed (exit code 1): no permission',
    );
    expect(await Bun.file(bin).text()).toBe(before); // not swapped
    expect(await leftoverTemps()).toEqual([]);
  });

  it('does not throw when spawning fails entirely', async () => {
    // the one boundary file control can't reach: the spawn API itself failing.
    // Persistent (not Once): the --version pre-check spawns first, and its
    // failure alone would fall through to a working update
    const spawnSpy = spyOn(Bun, 'spawn').mockImplementation(() => {
      throw new Error('ENOENT');
    });
    try {
      await updateYtdlp();
    } finally {
      spawnSpy.mockRestore();
    }
    expect(consoleError).toHaveBeenCalledWith(
      'yt-dlp self-update failed:',
      expect.anything(),
    );
    expect(await leftoverTemps()).toEqual([]);
  });

  it('skips the copy entirely when the live version matches the latest release', async () => {
    await Bun.write(`${ctrl}/version`, 'TEST-LATEST'); // == githubMock.latestTag
    const before = await Bun.file(bin).text();

    await updateYtdlp();

    expect(await Bun.file(bin).text()).toBe(before);
    expect(consoleDebug).toHaveBeenCalledWith('yt-dlp already up to date');
    // the args log records run() invocations only: no --update ever spawned
    expect(await Bun.file(`${ctrl}/args`).exists()).toBe(false);
    expect(await leftoverTemps()).toEqual([]);
  });

  it('skips the tick when the release check fails (no copy churn)', async () => {
    githubMock.latestTag = null; // the API call 500s
    try {
      const before = await Bun.file(bin).text();

      await updateYtdlp();

      // no copy, no --update: a failed check must not re-run the 35MB dance
      // every poll for the whole outage
      expect(await Bun.file(`${ctrl}/args`).exists()).toBe(false);
      expect(await Bun.file(bin).text()).toBe(before);
      expect(await leftoverTemps()).toEqual([]);
    } finally {
      githubMock.latestTag = 'TEST-LATEST';
    }
  });

  it('falls through to the full update when its own version is unreadable', async () => {
    // an empty --version means the binary may be broken, which is exactly
    // what an update might fix
    await Bun.write(`${ctrl}/version`, '');
    await Bun.write(`${ctrl}/stdout`, 'yt-dlp is up to date');

    await updateYtdlp();

    expect((await Bun.file(`${ctrl}/args`).text()).trim()).toContain(
      '--update-to nightly',
    );
  });

  it('never self-updates a test stub (dev has test/bin on PATH)', async () => {
    // "updating" the stub would run --update through its delegation and
    // rewrite the real binary in place, the non-atomic hazard this skips.
    // cwd-relative: the repo root is /app in the container but not in CI,
    // and realpath must succeed for the stub check to be reached
    whichSpy.mockReturnValue(`${process.cwd()}/test/bin/yt-dlp`);
    await updateYtdlp();
    expect(consoleDebug).toHaveBeenCalledWith(
      'yt-dlp resolves to a test stub; skipping self-update',
    );
    expect(await leftoverTemps()).toEqual([]);
  });

  it('skips gracefully when yt-dlp is not on PATH', async () => {
    whichSpy.mockReturnValue(null);
    await updateYtdlp();
    expect(consoleError).toHaveBeenCalledWith(
      'yt-dlp not on PATH; skipping self-update',
    );
  });
});

describe('probeDuration', () => {
  // probeDuration guards on the file existing (an uploaded blob's bytes are
  // gone), so these need a real file for ffprobe to run against
  const file = `${VIDEO_DIR}probe.mp4`;
  beforeEach(() => Bun.write(file, 'x'));

  it('returns the rounded duration from ffprobe', async () => {
    await stub({ stdout: '12.62\n' });
    expect(await probeDuration(file)).toBe(13);
    expect(await stubArgs()).toContain('ffprobe');
    expect(await stubArgs()).toEndWith(file);
  });

  it('returns undefined and logs when ffprobe fails', async () => {
    const consoleError = spyMock(console, 'error');
    await stub({ exit: '1', stderr: 'corrupt file' });

    expect(await probeDuration(file)).toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      `ffprobe failed for ${file} (exit 1): corrupt file`,
    );
  });

  it('returns undefined for unparseable output', async () => {
    await stub({ stdout: 'not a number' });
    expect(await probeDuration(file)).toBeUndefined();
  });

  it('returns undefined without spawning ffprobe when the file is gone', async () => {
    await stub({ stdout: '12.62\n' });
    expect(await probeDuration(`${VIDEO_DIR}missing.mp4`)).toBeUndefined();
    expect(await stubArgs()).toBe(''); // ffprobe never ran
  });
});

describe('getInfo', () => {
  const url = 'https://test.invalid/getinfo';
  const urlInfo = { ...VideoInfo, webpage_url: url };
  const infoStr = JSON.stringify(urlInfo);

  beforeEach(() => stub({ stdout: infoStr }));

  const infoRow = (u: string) =>
    db.query('SELECT info FROM video_info WHERE url = ?').get(u) as {
      info: string;
    } | null;
  const infoCount = () => rowCount('video_info');

  it('returns cached info from the DB without scraping', async () => {
    seedInfoRow(url, { filename: 'cached.mp4' });

    const info = await getInfo(log as any, url);

    expect(info.filename).toBe('cached.mp4');
    expect(await stubArgs()).toBe(''); // no scrape
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('bypasses the cache for a verbose request so its output is streamed', async () => {
    seedInfoRow(url, { filename: 'cached.mp4' });

    const info = await getInfo(log as any, url, true); // verbose

    expect(info).toEqual(urlInfo); // freshly scraped, not the cached row
    expect(await stubArgs()).toEndWith(`yt-dlp ${url} --verbose --dump-json`);
  });

  it('scrapes and caches when not in the DB', async () => {
    const info = await getInfo(log as any, url);

    expect(info).toEqual(urlInfo);
    expect(appendedText()).toBe(`\u{1f9d0} <b>Scraping</b> ${url}...`);
    expect(await stubArgs()).toEndWith(
      `yt-dlp ${url} --no-warnings --dump-json`,
    );
    expect(JSON.parse(infoRow(url)!.info)).toEqual(urlInfo);
  });

  it('caches the canonical url too, so an alias request skips the scrape', async () => {
    const canon = 'https://test.invalid/canonical';
    const canonInfo = { ...VideoInfo, webpage_url: canon };
    await stub({ stdout: JSON.stringify(canonInfo) });

    const info = await getInfo(log as any, url); // request an alias
    expect(info.webpage_url).toBe(canon);
    expect(infoCount()).toBe(2); // alias + canonical, no duplicate

    // a later request for the canonical hits the DB, not the scraper
    getInfo.cache.clear(); // drop the in-memory memo to force a DB read
    await stub({ stdout: 'not valid json: must not be scraped' });
    const again = await getInfo(log as any, canon);
    expect(again.webpage_url).toBe(canon);
    expect(infoCount()).toBe(2);
  });

  it('ignores a stale row (expired signed URLs) and re-scrapes over it', async () => {
    // a row past the TTL: its embedded media URLs have expired, so replaying
    // it would fail the download; getInfo must scrape fresh and UPSERT over it
    seedInfoRow(url, { filename: 'stale.mp4' }, Date.now() - 7 * 60 * 60 * 1000); // 7h > the 6h TTL

    const info = await getInfo(log as any, url);

    expect(info.filename).toBe(VideoInfo.filename); // the fresh scrape
    expect(infoRow(url)!.info).toBe(JSON.stringify(urlInfo)); // row refreshed
  });

  it('drops the proc from liveYtdlp even when the scrape throws', async () => {
    // the execYtdlp finally must clear the Set on every exit path; a leaked
    // dead proc would grow the Set unbounded and let abortDownloads kill a
    // stale handle. A nonzero exit throws AFTER the finally ran.
    await stub({ exit: '1', stderr: 'boom' });
    await expect(getInfo(log as any, url)).rejects.toBeInstanceOf(YtdlpError);
    expect(liveYtdlpSize()).toBe(0);
  });

  it('removeCachedInfo evicts the url row and its canonical alias together', async () => {
    const canon = 'https://test.invalid/canonical2';
    const canonInfo = { ...VideoInfo, webpage_url: canon };
    await stub({ stdout: JSON.stringify(canonInfo) });
    const info = await getInfo(log as any, url);
    expect(infoCount()).toBe(2);

    removeCachedInfo(info);

    expect(infoCount()).toBe(0); // both rows share the webpage_url
  });
});

describe('yt-dlp concurrency', () => {
  it('runs at most 3 yt-dlp processes at once', async () => {
    const urls = [0, 1, 2, 3, 4].map((i) => `https://test.invalid/cap/${i}`);
    await stub({ stdout: JSON.stringify(VideoInfo), block: '1' });

    const all = Promise.all(urls.map((u) => getInfo(log as any, u)));
    const spawned = async () =>
      (await stubArgs()).split('\n').filter(Boolean).length;
    await waitUntil(async () => (await spawned()) >= 3);
    await Bun.sleep(150); // give a 4th process the chance to (wrongly) spawn
    expect(await spawned()).toBe(3);

    await rm(`${STUB_DIR}/block`);
    await all;
    expect((await stubArgs()).split('\n').filter(Boolean)).toHaveLength(5);
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
    const consoleTable = spyMock(console, 'table');
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

  it('omits the resolution line for a purely numeric format_id with no dims', async () => {
    await sendInfo(log as any, {
      ...VideoInfo,
      width: 0,
      height: 0,
      resolution: undefined,
      format_id: '7',
    } as any);
    expect(appendedText()).not.toContain('resolution');
  });

  it('omits the resolution line when format_id is missing too', async () => {
    await sendInfo(log as any, {
      ...VideoInfo,
      width: 0,
      height: 0,
      resolution: undefined,
      format_id: undefined,
    } as any);
    expect(appendedText()).not.toContain('resolution');
  });

  it('escapes HTML metacharacters in scraped values', async () => {
    // scraped titles/filenames can contain <>&; unescaped they'd be parsed as
    // (broken) entities and 400 the whole message
    await sendInfo(log as any, {
      ...VideoInfo,
      filename: 'file<i>.mp4',
      webpage_url: 'https://x?a=1&b=2',
    } as any);
    expect(appendedText()).toContain('<b>filename</b>: file&lt;i&gt;.mp4');
    expect(appendedText()).toContain('<b>URL</b>: https://x?a=1&amp;b=2');
  });

  it('estimates size from tbr in the right units (kilobits, not bytes)', async () => {
    // tbr is kilobits/second: bytes = duration * tbr * 1000 / 8. duration 100s
    // at 800 kbps -> 10,000,000 bytes -> 9.54 MB. Treating tbr as bytes would
    // have shown ~1.15 GB, inflating the estimate ~125x.
    await sendInfo(log as any, {
      ...VideoInfo,
      duration: 100,
      tbr: 800,
      filesize: undefined,
      filesize_approx: undefined,
    } as any);
    expect(appendedText()).toContain('<b>size</b>: 9.54 MB');
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

// seed a blob row for VideoInfo through the real store helpers, so the seed
// can't drift from what the code under test reads
const seedBlob = (fileId: string | null = null) => {
  recordBlob(VideoInfo);
  if (fileId) setBlobFileId(VideoInfo, fileId);
};

describe('downloadVideo', () => {
  const infoJson = `${blobPath(VideoInfo)}.json`;

  it('abortDownloads kills a live yt-dlp and surfaces ShutdownAbort; new spawns refuse', async () => {
    await stub({ block: '1', outfile: VideoInfo.filename });
    const inflight = downloadVideo(log as any, VideoInfo).catch((e) => e);
    await waitUntil(async () => (await stubArgs()) !== ''); // yt-dlp is running

    abortDownloads();
    try {
      expect((await inflight).name).toBe('ShutdownAbort');
      // the row-less phase is irrelevant here; what matters is no spawn:
      const refused = await downloadVideo(log as any, {
        ...VideoInfo,
        id: 'other',
      }).catch((e) => e);
      expect(refused.name).toBe('ShutdownAbort');
      expect((await stubArgs()).split('\n').filter(Boolean)).toHaveLength(1);
    } finally {
      resetShutdown();
      await rm(`${STUB_DIR}/block`, { force: true });
    }
  });

  it.each([
    { signal: 'TERM', message: 'Timed out after 300 seconds' },
    { signal: 'KILL', message: 'yt-dlp was killed with signal SIGKILL' },
    // no ERROR line on stderr → the exit code is all we can say
    { exit: '1', message: 'yt-dlp exited with code 1' },
    // yt-dlp said why → its LAST ERROR line (the fatal one) is the message
    {
      exit: '1',
      stderr: 'WARNING: w\nERROR: transient\nERROR: Unsupported URL: https://x\n',
      message: 'Unsupported URL: https://x',
    },
    // the [extractor] tag and self-repeating "(caused by ...)" are de-noised
    {
      exit: '1',
      stderr:
        'ERROR: [generic] Unable to download webpage: HTTP Error 502: BAD GATEWAY (caused by <HTTPError 502: BAD GATEWAY>)\n',
      message: 'Unable to download webpage: HTTP Error 502: BAD GATEWAY',
    },
  ])(
    'error messages for failures: %j',
    async ({ signal, exit, stderr, message }) => {
      if (signal) await stub({ signal });
      if (exit) await stub({ exit });
      if (stderr) await stub({ stderr });
      // exact match, not substring: a missed de-noise would still contain the
      // clean message and slip past toThrow
      const err = await downloadVideo(log as any, VideoInfo).catch((e) => e);
      expect(err.message).toBe(message);
    },
  );

  it('does not coalesce two different videos that share a filename', async () => {
    // a title collision: same yt-dlp template path, different identity. The
    // coalescer must not hand one video the other's in-flight download (it
    // would record the wrong bytes under both keys); each download writes
    // under its own staging home, so neither clobbers the other.
    const a = { ...VideoInfo, extractor: 'test', id: 'collide-a' };
    const b = { ...VideoInfo, extractor: 'test', id: 'collide-b' };
    await stub({ outfile: VideoInfo.filename });

    await Promise.all([
      downloadVideo(log as any, a as any),
      downloadVideo(log as any, b as any),
    ]);

    // two yt-dlp spawns (not one shared; ffprobe lines follow each download),
    // and each got its own blob
    expect(
      (await stubArgs()).split('\n').filter((l) => l.includes('yt-dlp')),
    ).toHaveLength(2);
    expect(getBlob(a as any)).not.toBeNull();
    expect(getBlob(b as any)).not.toBeNull();
    expect(await Bun.file(blobPath(a as any)).exists()).toBe(true);
    expect(await Bun.file(blobPath(b as any)).exists()).toBe(true);
  });

  it("returns 'already downloaded' when the blob has a file_id", async () => {
    seedBlob('file-id');
    expect(await downloadVideo(log as any, VideoInfo)).toBe(
      'already downloaded',
    );
    expect(await stubArgs()).toBe('');
  });

  it("returns 'already downloaded' when the blob bytes are on disk", async () => {
    seedBlob();
    await Bun.write(blobPath(VideoInfo), 'video bytes');
    expect(await downloadVideo(log as any, VideoInfo)).toBe(
      'already downloaded',
    );
    expect(await stubArgs()).toBe('');
  });

  it('downloads via --load-info-json, then moves the blob to its identity path and records it', async () => {
    await stub({ stdout: 'downloaded ok', outfile: VideoInfo.filename });

    expect(await downloadVideo(log as any, VideoInfo)).toBe('downloaded ok');

    const [ytdlpLine, probeLine] = (await stubArgs()).split('\n');
    // a per-download staging home under STAGING_DIR, then the temp info json
    expect(ytdlpLine).toContain(`--paths home:${STAGING_DIR}/`);
    expect(ytdlpLine).toEndWith(`--load-info-json ${infoJson}`);
    // the real duration is probed right after the move, while the bytes are
    // guaranteed present (here the stub's stdout isn't numeric, so none stored)
    expect(probeLine).toContain('ffprobe');
    expect(probeLine).toContain(blobPath(VideoInfo));
    expect(appendedText()).toContain('\u2b07\ufe0f <b>Downloading...</b>');
    // bytes moved to the identity-keyed path; a blob row records them
    expect(await Bun.file(blobPath(VideoInfo)).text()).toBe('video bytes\n');
    expect(getBlob(VideoInfo)?.path).toBe(blobPath(VideoInfo));
    expect(await Bun.file(infoJson).exists()).toBe(false); // temp cleaned up
    // the per-download staging home is cleaned up with the download
    expect(await readdir(STAGING_DIR).catch(() => [])).toEqual([]);
  });

  it('succeeds when yt-dlp writes a metadata sidecar next to the video', async () => {
    await stub({
      stdout: 'downloaded ok',
      outfile: VideoInfo.filename,
      sidecar: '1',
    });

    expect(await downloadVideo(log as any, VideoInfo)).toBe('downloaded ok');

    expect(await Bun.file(blobPath(VideoInfo)).text()).toBe('video bytes\n');
    expect(getBlob(VideoInfo)?.path).toBe(blobPath(VideoInfo));
  });

  it('stores the probed duration on the blob row', async () => {
    // the shared stub stdout serves both spawns: yt-dlp's return value (not
    // asserted here) and ffprobe's duration output
    await stub({ stdout: '321', outfile: VideoInfo.filename });

    await downloadVideo(log as any, VideoInfo);

    expect(getBlob(VideoInfo)?.duration).toBe(321);
  });

  it('logs stderr as it streams', async () => {
    await stub({ stderr: 'progress line', outfile: VideoInfo.filename });
    await downloadVideo(log as any, VideoInfo);
    expect(appendedText()).toContain('<code>progress line</code>');
  });

  it('throws a YtdlpError carrying stderr, classified permanent for unsupported URLs', async () => {
    await stub({ exit: '1', stderr: 'ERROR: Unsupported URL: https://x\n' });
    const err = await downloadVideo(log as any, VideoInfo).catch((e) => e);
    expect(err).toBeInstanceOf(YtdlpError);
    expect(err.stderr).toContain('Unsupported URL');
    expect(isPermanentError(err)).toBe(true);
  });

  it('bounds the retained stderr on a line boundary, keeping the trailing error', async () => {
    const filler = 'progress line\n'.repeat(25000); // ~325KB of whole lines, over the cap
    await stub({
      exit: '1',
      stderr: `${filler}ERROR: Unsupported URL: https://x\n`,
    });
    const err = await downloadVideo(log as any, VideoInfo).catch((e) => e);
    expect(err).toBeInstanceOf(YtdlpError);
    expect(err.stderr.length).toBeLessThan(200 * 1024); // capped
    expect(err.stderr).toContain('Unsupported URL'); // trailing error survived
    expect(err.stderr.startsWith('progress line')).toBe(true); // trimmed at a line start
    expect(isPermanentError(err)).toBe(true);
  });

  it('classifies a transient yt-dlp failure (5xx) as retryable', async () => {
    await stub({
      exit: '1',
      stderr: 'ERROR: Unable to download webpage: HTTP Error 503\n',
    });
    const err = await downloadVideo(log as any, VideoInfo).catch((e) => e);
    expect(err).toBeInstanceOf(YtdlpError);
    expect(isPermanentError(err)).toBe(false);
  });
});

describe('isPermanentError', () => {
  it.each([
    'ERROR: Unsupported URL: https://x',
    'ERROR: [generic] Unable to extract data',
    'ERROR: [Instagram] DaaWmzzAH9s: No video formats found!; please report this issue',
    'ERROR: Private video. Sign in if you have access',
    'ERROR: Video unavailable',
    'ERROR: This video is no longer available',
    'ERROR: Join this channel for members-only content',
    'ERROR: Sign in to confirm your age',
    'ERROR: [generic] Unable to download webpage: HTTP Error 404: Not Found',
    'ERROR: Unable to download webpage: HTTP Error 410: Gone',
    'ERROR: [generic] Sorites_paradox: Unable to download webpage: HTTP Error 403: Forbidden (caused by <HTTPError 403: Forbidden>)',
  ])('treats %j as permanent', (stderr) => {
    expect(isPermanentError(new YtdlpError('failed', stderr))).toBe(true);
  });

  it.each([
    'ERROR: Unable to download webpage: HTTP Error 503', // 5xx: transient
    'ERROR: Unable to download webpage: HTTP Error 429: Too Many Requests',
    'ERROR: unable to download video data: HTTP Error 403: Forbidden', // segment
    'ERROR: unable to download video data: HTTP Error 404: Not Found', // segment
    'ERROR: [youtube] Connection reset by peer',
    '',
  ])('treats %j as retryable', (stderr) => {
    expect(isPermanentError(new YtdlpError('failed', stderr))).toBe(false);
  });

  it('matches only ERROR: lines, not permanent-looking WARNINGs', () => {
    const stderr =
      'WARNING: unable to extract view count; please report this\n' +
      'ERROR: Unable to download webpage: HTTP Error 503';
    expect(isPermanentError(new YtdlpError('failed', stderr))).toBe(false);
  });

  it('treats a signal-killed failure as retryable even if stderr looks permanent', () => {
    const e = new YtdlpError('Timed out', 'ERROR: Unsupported URL: x', true);
    expect(isPermanentError(e)).toBe(false);
  });

  it('treats a plain (non-yt-dlp, non-Telegram) error as retryable', () => {
    expect(isPermanentError(new Error('Unsupported URL'))).toBe(false);
    expect(isPermanentError('Unsupported URL')).toBe(false);
    expect(isPermanentError(undefined)).toBe(false);
  });

  it('treats any Telegram 403 as permanent (description need not match)', () => {
    // a 403 whose text matches NO description pattern: proves the 403 branch
    // classifies on its own, not via the 400 description regex
    expect(
      isPermanentError({
        response: {
          error_code: 403,
          description: "Forbidden: bot can't initiate conversation with a user",
        },
      }),
    ).toBe(true);
  });

  it('treats a Telegram 400 "chat not found" as permanent', () => {
    expect(
      isPermanentError({
        response: {
          error_code: 400,
          description: 'Bad Request: chat not found',
        },
      }),
    ).toBe(true);
    // the reply target was deleted: retrying the same send can never succeed
    expect(
      isPermanentError({
        response: {
          error_code: 400,
          description: 'Bad Request: message to be replied not found',
        },
      }),
    ).toBe(true);
  });

  it('treats a Telegram 429 / 5xx as retryable, even if its text echoes a permanent phrase', () => {
    expect(
      isPermanentError({
        response: {
          error_code: 429,
          description: 'Too Many Requests: retry after 5',
        },
      }),
    ).toBe(false);
    expect(
      isPermanentError({
        // a transient code whose description happens to echo "chat not found"
        response: {
          error_code: 500,
          description: 'Internal Server Error: chat not found',
        },
      }),
    ).toBe(false);
  });
});

describe('classifyFailure', () => {
  it('classifies an Instagram empty-media response as unavailable', () => {
    expect(
      classifyFailure(
        new YtdlpError(
          'failed',
          'ERROR: [Instagram] Da4FbMds5BU: Instagram sent an empty media response. Check if this post is accessible in your browser without being logged-in.',
        ),
      ),
    ).toBe('unavailable');
  });

  it.each([
    'ERROR: Unsupported URL: https://example.com/article',
    'ERROR: [Reddit] 92dd8: No media found',
    'ERROR: [Instagram] DbHhjdBJT9O: There is no video in this post',
  ])('classifies %j as not-a-video', (stderr) => {
    expect(classifyFailure(new YtdlpError('failed', stderr))).toBe(
      'not-a-video',
    );
  });

  it('keeps the f4m downloader\'s untagged "No media found" retryable', () => {
    expect(
      classifyFailure(new YtdlpError('failed', 'ERROR: No media found')),
    ).toBe('transient');
  });

  it.each([
    'ERROR: Private video. Sign in if you have access',
    'ERROR: Unable to download webpage: HTTP Error 410: Gone',
  ])('classifies %j as unavailable', (stderr) => {
    expect(classifyFailure(new YtdlpError('failed', stderr))).toBe('unavailable');
  });

  it('not-a-video wins over unavailable when both patterns are present', () => {
    const stderr =
      'ERROR: Video unavailable\nERROR: Unsupported URL: https://x';
    expect(classifyFailure(new YtdlpError('failed', stderr))).toBe(
      'not-a-video',
    );
  });

  it('classifies an Instagram rate-limit as transient (not unavailable)', () => {
    expect(
      classifyFailure(
        new YtdlpError(
          'failed',
          'ERROR: [Instagram] xyz: Requested content is not available, rate-limit reached or login required',
        ),
      ),
    ).toBe('transient');
  });

  it('diverges from isPermanentError on a Telegram permanent error', () => {
    const e = telegramError(403, 'Forbidden: bot was blocked by the user');
    expect(classifyFailure(e)).toBe('transient');
    expect(isPermanentError(e)).toBe(true);
  });
});

describe('sendVideo', () => {
  const cachedFileId = () => getBlob(VideoInfo)?.file_id;

  it('uploads the bytes, caches the file_id, and deletes the upload', async () => {
    seedBlob();
    await Bun.write(blobPath(VideoInfo), 'video bytes');

    const msg = await sendVideo(telegram, log as any, VideoInfo, 123);

    expect(mockSendVideo).toHaveBeenCalledWith(
      123,
      Bun.pathToFileURL(blobPath(VideoInfo)).href,
      expect.objectContaining({ width: 100, height: 100, duration: 10 }),
    );
    expect(msg!.video.file_id).toBe('id');
    expect(cachedFileId()).toBe('id');
    expect(await Bun.file(blobPath(VideoInfo)).exists()).toBe(false); // upload deleted
  });

  it('resends by file_id without touching the bytes', async () => {
    seedBlob('cached-file-id');

    await sendVideo(telegram, log as any, VideoInfo, 123);

    expect(mockSendVideo).toHaveBeenCalledWith(
      123,
      'cached-file-id',
      expect.anything(),
    );
  });

  it('drops the bytes when the video is too large (never sent)', async () => {
    seedBlob();
    await Bun.write(blobPath(VideoInfo), ''); // allocate, then grow sparsely
    await truncate(blobPath(VideoInfo), 2001 * 1024 * 1024);

    expect(
      await sendVideo(telegram, log as any, VideoInfo, 123),
    ).toBeUndefined();
    expect(appendedText()).toContain('\u{1f61e} Video too large (2001.00 MB)');
    expect(mockSendVideo).not.toHaveBeenCalled();
    // releaseBlob dropped it: bytes unlinked and the blob row gone, so the
    // multi-GB file doesn't leak forever (the job completes without a catch)
    expect(await Bun.file(blobPath(VideoInfo)).exists()).toBe(false);
    expect(rowCount('blobs')).toBe(0);
  });

  it('throws if the blob bytes are not found', async () => {
    await expect(
      sendVideo(telegram, log as any, VideoInfo, 123),
    ).rejects.toThrow('yt-dlp output file not found');
  });

  it('does not reject when post-send cleanup fails (so the job will not re-send)', async () => {
    seedBlob();
    await Bun.write(blobPath(VideoInfo), 'video bytes');
    const consoleError = spyMock(console, 'error');
    // caching the file_id (a real UPDATE on the real blobs table) throws,
    // exercising the genuine cleanup-catch path
    await withFailingWrite('blobs', 'UPDATE', async () => {
      const msg = await sendVideo(telegram, log as any, VideoInfo, 123);

      expect(mockSendVideo).toHaveBeenCalledTimes(1); // sent once, did not reject
      expect(msg!.video.file_id).toBe('id');
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('Post-send cleanup failed'),
        expect.any(Error),
      );
      expect(await Bun.file(blobPath(VideoInfo)).exists()).toBe(true); // bytes kept
    });
  });

  it('sends the video as a reply message if requested', async () => {
    seedBlob();
    await Bun.write(blobPath(VideoInfo), 'video bytes');

    await sendVideo(telegram, log as any, VideoInfo, 123, 42);

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

describe('sendVideo dead file_id recovery', () => {
  it('clears a file_id the server no longer recognizes, so a retry re-downloads', async () => {
    seedBlob('dead-file-id'); // e.g. cached before the server data was reset
    const tg = {
      sendVideo: mock(() =>
        Promise.reject(
          // wording captured from the real bot-api server
          telegramError(
            400,
            "Bad Request: wrong remote file identifier specified: can't unserialize it. Wrong last symbol",
          ),
        ),
      ),
    };

    await expect(
      sendVideo(tg as any, log as any, VideoInfo, 1),
    ).rejects.toThrow('wrong remote file identifier');

    expect(getBlob(VideoInfo)?.file_id).toBeNull(); // cleared: retry re-downloads
  });

  it('keeps the file_id on unrelated send failures', async () => {
    seedBlob('good-file-id');
    const tg = { sendVideo: mock(() => Promise.reject(new Error('fetch failed'))) };
    await expect(
      sendVideo(tg as any, log as any, VideoInfo, 1),
    ).rejects.toThrow('fetch failed');
    expect(getBlob(VideoInfo)?.file_id).toBe('good-file-id');
  });
});

describe('releaseBlob at the download layer', () => {
  it('releases the bytes; a later downloadVideo re-downloads (no stale memo)', async () => {
    recordBlob(VideoInfo);
    await Bun.write(blobPath(VideoInfo), 'bytes');

    await releaseBlob(VideoInfo);

    expect(await Bun.file(blobPath(VideoInfo)).exists()).toBe(false);
    expect(rowCount('blobs')).toBe(0);
    // the download coalescer holds in-flight entries only, so there is no
    // settled memo left to replay a stale "already downloaded" from
    expect(downloadVideo.cache.size).toBe(0);
  });

  it('keeps an uploaded blob (file_id is its resend cache)', async () => {
    recordBlob(VideoInfo);
    setBlobFileId(VideoInfo, 'fid');

    await releaseBlob(VideoInfo);

    // the row survives as the file_id cache; only its (already-gone) bytes drop
    expect(rowCount('blobs')).toBe(1);
  });
});
