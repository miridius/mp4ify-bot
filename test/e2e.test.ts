import { $ } from 'bun';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  mock,
} from 'bun:test';
import { rm } from 'fs/promises';
import { resetDb } from '../src/db';
import { downloadVideo, getInfos } from '../src/download-video';
import { SEVERAL_VIDEOS } from '../src/handlers';
import { jobsIdle, seedJob, setRetryBaseMs } from '../src/job-queue';
import {
  FORMAT_ID_RE,
  MOCK_GROUP_CHAT,
  MOCK_USER_ID,
  withBotApi,
  type MockBotApi,
} from './simulate-bot-api';
import {
  resetStub,
  rowCount,
  seedBytes,
  spyMock,
  STUB_DIR,
  stub,
  urlMessage,
  waitUntil,
} from './test-utils';

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

const runInGroup = async (
  api: MockBotApi,
  msg: ReturnType<typeof urlMessage>,
  timeout: number,
) => {
  api.sendTextMessageToBot(msg, MOCK_GROUP_CHAT);
  // a never-started job would pass a silence assertion vacuously
  expect(await waitUntil(() => !jobsIdle(), 15_000)).toBe(true);
  expect(await waitUntil(jobsIdle, timeout)).toBe(true);
};

const expectSilenceOrRateLimitReport = (api: MockBotApi) => {
  if (!api.sentMessages.length) return false;
  const reports = api.sentMessages.filter(isFailureReport);
  expect(reports).toHaveLength(1);
  expect(api.sentMessages).toEqual(reports);
  expect(reports[0]!.text).toMatch(
    /rate.?limit|login required|empty media response/i,
  );
  return true;
};

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
  getInfos.cache.clear();
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

  it.each([
    // a lone photo
    'https://www.instagram.com/p/DbHhjdBJT9O/',
    // a photo carousel (see PHOTO_ITEM)
    'https://www.instagram.com/p/Dbnd-yeAP9S/',
  ])(
    'stays silent for a not-a-video link in a group: %s',
    (url) =>
      withBotApi(async (api) => {
        clearInMemoryCache();
        await runInGroup(api, urlMessage(url), 25_000);
        expectSilenceOrRateLimitReport(api);
      }),
    45_000,
  );

  it.if(!!Bun.env.TEST_E2E_FULL)(
    'refuses a post holding several videos',
    () =>
      withBotApi(async (api) => {
        clearInMemoryCache();
        // a post holding three videos and a photo
        const post = urlMessage('https://www.instagram.com/p/DIqghhpok2K/');
        const isVerdict = (m: { text?: string }) =>
          !!m.text?.includes(SEVERAL_VIDEOS);

        await runInGroup(api, post, 120_000);
        if (expectSilenceOrRateLimitReport(api)) return;

        api.sendTextMessageToBot(post);
        expect(
          await waitUntil(() => api.sentMessages.some(isVerdict), 10_000),
        ).toBe(true);
        expect(await waitUntil(jobsIdle, 10_000)).toBe(true);
        const reply = api.sentMessages.find(isVerdict)!.text!;
        expect(reply).not.toContain('🧐 <b>Scraping</b>');
        expect(api.sentMessages.filter((m: any) => m.video)).toEqual([]);
      }),
    150_000,
  );

  it(
    'reports one 💥 for a whitelisted failing link in a group',
    () =>
      withBotApi(async (api) => {
        setRetryBaseMs(1); // don't sleep the real backoff between attempts
        clearInMemoryCache();
        api.sendTextMessageToBot(
          urlMessage('https://www.instagram.com/reel/C0aaaaaaaaa/'),
          MOCK_GROUP_CHAT,
        );
        await waitUntil(() => api.sentMessages.some(isFailureReport), 60_000);
        const reports = api.sentMessages.filter(isFailureReport);
        expect(reports).toHaveLength(1);
        expect(reports[0]!.chat_id).toBe(MOCK_GROUP_CHAT.id);
        // id 0 is the link message: the first update in this fresh api
        expect((reports[0] as any).reply_parameters?.message_id).toBe(0);
      }),
    90_000,
  );
});

describe.todo('inline query handler');

// Network-free, so these run outside TEST_E2E.
describe('restart recovery', () => {
  afterEach(() => rm(STUB_DIR, { recursive: true, force: true }));

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
    await seedBytes(info as any, 'not a real video, but non-empty');
    // a job row left by a prior boot: recovery must run it
    seedJob({
      kind: 'confirmed',
      info,
      url: 'https://x',
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

    await resetStub();
    await stub({
      exit: '1',
      stderr:
        'ERROR: [generic] x: Unable to download webpage: [Errno -2] Name or service not known\n',
    });
    seedJob({
      kind: 'confirmed',
      info: { filename: '/storage/does-not-exist.mp4', title: 'T', webpage_url: 'https://x', duration: 1 },
      url: 'https://x',
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
