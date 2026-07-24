import { $ } from 'bun';
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  mock,
} from 'bun:test';
import { blobPath, recordBlob } from '../src/blob-store';
import { resetDb } from '../src/db';
import { downloadVideo, getInfo } from '../src/download-video';
import { jobsIdle, seedJob, setRetryBaseMs } from '../src/job-queue';
import { FORMAT_ID_RE, MOCK_USER_ID, withBotApi } from './simulate-bot-api';
import { rowCount, spyMock, waitUntil } from './test-utils';

beforeEach(() => jest.clearAllMocks());
afterAll(() => mock.restore());
spyMock(console, 'debug');
spyMock(console, 'table');

// e2e tests:
// 1. url each from youtube, insta, reddit
// 2. use real yt-dlp, but use fixtures for calls to bot-api
// 3. test message and in-line
// 4. test video id cache

const hiMessage = { text: 'hi' };

const isFailureReport = (m: { text?: string }) =>
  !!m.text && m.text.includes('💥 <b>Download failed</b>:');

const urlMessage = (url: string, verbose?: boolean) => ({
  text: verbose ? `/verbose ${url}` : url,
  entities: [
    {
      offset: verbose ? 9 : 0,
      length: (verbose ? 9 : 0) + url.length,
      type: 'url' as const,
    },
  ],
  link_preview_options: { is_disabled: true },
});

const testUrls = [
  'https://www.instagram.com/reel/DKbYQgeoL3F/?igsh=MTh4MnpnYm9hdjJ5OA==',
  // alias url
  'https://www.reddit.com/r/nextfuckinglevel/s/iGEii0a7V6',
  // canonical url for same video
  'https://www.reddit.com/r/nextfuckinglevel/comments/1l68isw/mix_of_coolness_agility_technique_power_and_a/?share_id=ejTJZnh_f4BZuzlnfcOUo',
  // only in full mode - see e2e.sh for the modes and why
  ...(Bun.env.TEST_E2E_FULL ? ['http://youtube.com/shorts/0COu-qMC18Y'] : []),
];

const clearDiskCache = async () => {
  resetDb(); // the durable cache lives in DB tables: clear its tables...
  // ...but keep the DB FILE: db.ts holds an open connection, and unlinking the
  // file out from under it would leave writes/reads on a ghost inode.
  await $`find /storage -mindepth 1 -maxdepth 1 -not -name 'mp4ify.db*' -exec rm -rf {} +`.catch(
    () => null,
  );
};

// yt-dlp's format selection shifts as sites change their offerings, which
// changes format ids in filenames, sizes, bitrates, and, because the blob is
// keyed by extractor:id:format, the format segment of the blob path and the
// file_id the mock derives from it: all without any change in bot behavior.
// Scrub those (the stable extractor:id of the path stays as real signal). NOT
// scrubbed (also real signal, still snapshot-breaking on a format change): codec
// profile strings, resolution, and duration.
const scrub = (messages: unknown) =>
  JSON.parse(
    JSON.stringify(messages)
      .replaceAll(FORMAT_ID_RE, '$1.<formats>$2')
      .replaceAll(/(\/storage\/blobs\/[^:"]+:[^:"]+:)[^"]+(\.\w+")/g, '$1<formats>$2')
      .replaceAll(/("video":")(?!file:)[0-9a-z]+(")/g, '$1<file_id>$2')
      .replaceAll(/\d+(\.\d+)? MB/g, '<n> MB')
      .replaceAll(/@ \d+(\.\d+)? kbps/g, '@ <n> kbps'),
  );

const clearInMemoryCache = () => {
  getInfo.cache.clear();
  downloadVideo.cache.clear();
};

describe.if(!!Bun.env.TEST_E2E)('message handler', async () => {
  await clearDiskCache();
  clearInMemoryCache();

  it('ignores messages without urls', () =>
    withBotApi(async (api) => {
      api.sendTextMessageToBot(hiMessage);
      await Bun.sleep(1000);
      expect(api.sentMessages).toMatchInlineSnapshot(`[]`);
    }));

  it.each(testUrls)(
    'downloads %s',
    (url) =>
      withBotApi(async (api) => {
        const waitForVideo = (ms: number) =>
          waitUntil(
            () =>
              api.sentMessages.length > 1 ||
              api.sentMessages.some(isFailureReport),
            ms,
          );

        // initial download
        clearInMemoryCache();
        api.sendTextMessageToBot(urlMessage(url));
        await waitForVideo(25_000);
        expect(scrub(api.sentMessages)).toMatchSnapshot('download');

        // in memory cache
        api.sentMessages.length = 0;
        api.sendTextMessageToBot(urlMessage(url));
        await waitForVideo(5_000);
        expect(scrub(api.sentMessages)).toMatchSnapshot('mem cache');

        // disk cache
        clearInMemoryCache();
        api.sentMessages.length = 0;
        api.sendTextMessageToBot(urlMessage(url));
        await waitForVideo(5_000);
        expect(scrub(api.sentMessages)).toMatchSnapshot('disk cache');
      }),
    40_000,
  );

  const groupChat = { id: -1000000000001, title: 'Test Group', type: 'supergroup' };

  it(
    'stays silent for a not-a-video link in a group',
    () =>
      withBotApi(async (api) => {
        clearInMemoryCache();
        api.sendTextMessageToBot(
          urlMessage('https://www.instagram.com/p/DbHhjdBJT9O/'),
          groupChat,
        );
        // gate on the job actually starting, else a never-started job passes this
        // silence test vacuously
        expect(await waitUntil(() => !jobsIdle(), 15_000)).toBe(true);
        await waitUntil(jobsIdle, 25_000);
        // a rate-limited scrape classifies 'unavailable' (whitelisted host =>
        // one terminal report), so tolerate that live-scrape degradation the
        // same way the download tests tolerate a 💥
        if (api.sentMessages.length) {
          const reports = api.sentMessages.filter(isFailureReport);
          expect(reports).toHaveLength(1);
          // pin the tolerated report to rate-limit/login wording: a broken
          // not-a-video gate would instead report "There is no video in this
          // post" and must still fail this test
          expect(reports[0]!.text).toMatch(/rate.?limit|login required|empty media response/i);
        } else {
          expect(api.sentMessages).toEqual([]);
        }
      }),
    45_000,
  );

  it(
    'reports one 💥 for a whitelisted failing link in a group',
    () =>
      withBotApi(async (api) => {
        setRetryBaseMs(1); // don't sleep the real backoff between attempts
        clearInMemoryCache();
        api.sendTextMessageToBot(
          urlMessage('https://www.instagram.com/reel/C0aaaaaaaaa/'),
          groupChat,
        );
        await waitUntil(() => api.sentMessages.some(isFailureReport), 60_000);
        const reports = api.sentMessages.filter(isFailureReport);
        expect(reports).toHaveLength(1);
        expect(reports[0]!.chat_id).toBe(groupChat.id);
        // id 0 is the link message: the first update in this fresh api
        expect((reports[0] as any).reply_parameters?.message_id).toBe(0);
      }),
    90_000,
  );
});

describe.todo('inline query handler');

// Drives the whole restart seam: a real bot boots and recovers a job persisted
// by a prior boot: the success case (blob already on disk, recovery just
// uploads) and the failure case (no blob, so the recovered download fails fast
// on placeholder info). Both are network-free, so they run in the normal suite
// rather than only under TEST_E2E.
describe('restart recovery', () => {
  it('runs a persisted job on the next boot and delivers its video', async () => {
    clearInMemoryCache(); // or a leftover memo masks the no-op this test checks
    resetDb();

    // a blob a prior boot downloaded: identity-keyed bytes + its DB row
    const info = {
      filename: '/storage/recovery-test.mp4',
      title: 'Recovered',
      webpage_url: 'https://x',
      duration: 1,
    };
    await Bun.write(blobPath(info), 'not a real video, but non-empty');
    // seed through the real store helper, exactly what a prior boot's
    // downloadVideo would have written
    recordBlob(info as any);
    // a job row left by a prior boot: recovery must run it
    seedJob({
      kind: 'confirmed',
      info,
      verbose: false,
      messageId: 1,
      chatId: MOCK_USER_ID,
      chatType: 'private',
      postDownload: true, // already downloaded; recovery only has to upload
    });

    await withBotApi(async (api) => {
      // jobsIdle flips true only after run() deletes the job row, so the count
      // assertion below can't race the delete
      await waitUntil(jobsIdle, 10_000);
      const video = api.sentMessages.find((m) => 'video' in m);
      expect(video).toBeDefined();
      expect(video!.chat_id).toBe(MOCK_USER_ID);
      expect(rowCount('jobs')).toBe(0);
    });
  });

  it('reports a confirmed job failure through one edited message across retries', async () => {
    clearInMemoryCache();
    setRetryBaseMs(1); // don't sleep the real 1s+2s backoff in the test
    resetDb();

    // a confirmed job with no recorded blob: recovery re-runs the download,
    // which throws (the placeholder info isn't a real video) → retryable, so it
    // reports through the real (group-capable) LogMessage, editing one message
    // ⚠️→⚠️→💥 across the 3 attempts rather than sending three
    seedJob({
      kind: 'confirmed',
      info: { filename: '/storage/does-not-exist.mp4', title: 'T', webpage_url: 'https://x', duration: 1 },
      verbose: false,
      messageId: 1,
      chatId: MOCK_USER_ID,
      chatType: 'private', // group retries would stay silent (terminal only)
      postDownload: true,
    });

    await withBotApi(async (api) => {
      await waitUntil(jobsIdle, 10_000);
      const failures = api.sentMessages.filter((m) =>
        m.text?.includes('Download failed'),
      );
      expect(failures).toHaveLength(1); // one message, edited across retries
      expect(failures[0]!.text).toContain('💥'); // edited to the terminal report
      expect(failures[0]!.text).toContain('⚠️'); // retries append; earlier attempts stay visible
      expect(failures[0]!.chat_id).toBe(MOCK_USER_ID);
    });
  });
});
