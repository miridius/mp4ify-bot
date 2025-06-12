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
import { downloadVideo, getInfo, sendVideo } from '../src/download-video';
import { withBotApi } from './simulate-bot-api';
import { spyMock, waitUntil } from './test-utils';

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
  // fails if we run the test too often
  'http://youtube.com/shorts/0COu-qMC18Y',
];

const clearDiskCache = async () => $`rm -rf /storage/*`.catch(() => null);

const clearInMemoryCache = () => {
  getInfo.cache.clear();
  downloadVideo.cache.clear();
  sendVideo.cache.clear();
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
              api.sentMessages.some(({ text }) =>
                text?.includes('💥 <b>Download failed</b>:'),
              ),
            ms,
          );

        // initial download
        clearInMemoryCache();
        api.sendTextMessageToBot(urlMessage(url));
        await waitForVideo(25_000);
        expect(api.sentMessages).toMatchSnapshot('download');

        // in memory cache
        api.sentMessages.length = 0;
        api.sendTextMessageToBot(urlMessage(url));
        await waitForVideo(5_000);
        expect(api.sentMessages).toMatchSnapshot('mem cache');

        // disk cache
        clearInMemoryCache();
        api.sentMessages.length = 0;
        api.sendTextMessageToBot(urlMessage(url));
        await waitForVideo(5_000);
        expect(api.sentMessages).toMatchSnapshot('disk cache');
      }),
    40_000,
  );
});

describe.todo('inline query handler');
