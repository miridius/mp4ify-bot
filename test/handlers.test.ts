import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  mock,
} from 'bun:test';
import { rm } from 'fs/promises';
import {
  getBlob,
  recordBlob,
  setBlobDuration,
  setBlobFileId,
} from '../src/blob-store';
import { db, resetDb } from '../src/db';
import payloads from './fixtures/real-payloads.json';
import {
  abortDownloads,
  MAX_DOWNLOADS_REACHED,
  resetShutdown,
  VIDEOS_TO_DECIDE,
  type VideoInfo,
} from '../src/download-video';
import { INLINE_CACHE_CHAT_ID } from '../src/consts';
import { inlineIdle, processJob, SEVERAL_VIDEOS } from '../src/handlers';
import {
  jobsIdle,
  setRetryBaseMs,
  type ConfirmedJob,
  type UrlJob,
} from '../src/job-queue';
import { setRetryPassDelayMs } from '../src/log-message';
import {
  GONE_REPLY_ID,
  MOCK_GROUP_CHAT,
  MOCK_USER_ID,
  REAL_ERRORS,
  withBotApi,
  type MockBotApi,
} from './simulate-bot-api';
import {
  bytesOnDisk,
  resetStub,
  rowCount,
  seedBytes,
  seedHandledUrl,
  seedOversize,
  spyMock,
  STUB_DIR,
  stub,
  stubScrape,
  stubSpawns,
  unblockStub,
  urlMessage,
  waitUntil,
  withFailingWrite,
} from './test-utils';

const consoleError = spyMock(console, 'error');
spyMock(console, 'log');

beforeEach(async () => {
  jest.clearAllMocks();
  resetDb();
  await resetStub();
  setRetryBaseMs(1);
  setRetryPassDelayMs(0);
});
afterAll(async () => {
  await rm(STUB_DIR, { recursive: true, force: true });
  setRetryPassDelayMs();
  mock.restore();
});

const TEST_URL = 'https://example.com';
const LONG = 25 * 60;

const video = (over: Partial<VideoInfo> = {}): VideoInfo => ({
  webpage_url: TEST_URL,
  title: 'Test Video',
  extractor: 'test',
  id: 'id',
  filename: 'video.mp4',
  ext: 'mp4',
  ...over,
});

const tooBig = 3 * 1024 * 1024 * 1024;

const failScrape = (stderr: string) =>
  stub({ exit: '1', stderr: `${stderr}\n` });
const armDownload = () =>
  stub({ outfile: 'video.mp4' }, `${STUB_DIR}/download`);
const failDownload = (stderr: string) =>
  stub({ exit: '1', stderr: `${stderr}\n` }, `${STUB_DIR}/download`);
const armProbe = (secs: number) =>
  stub({ stdout: `${secs}\n` }, `${STUB_DIR}/ffprobe`);
const failProbe = () =>
  stub({ exit: '1', stderr: 'corrupt\n' }, `${STUB_DIR}/ffprobe`);
const serve = async (info = video()) => {
  await stubScrape([info]);
  await armDownload();
};

const scrapes = async () =>
  (await stubSpawns()).filter((l) => l.includes('--dump-json'));
const downloads = async () =>
  (await stubSpawns()).filter((l) => l.includes('--load-info-json'));
const probes = async () =>
  (await stubSpawns()).filter((l) => l.includes('/ffprobe '));

const messageOf = (u: any) => u.message ?? u.edited_message;
const sendText = (
  api: MockBotApi,
  msg: Parameters<MockBotApi['sendTextMessageToBot']>[0],
  edit: boolean,
) =>
  edit
    ? api.sendEditedMessageToBot({ message_id: 42, ...msg })
    : api.sendTextMessageToBot(msg);

const settle = async (api: MockBotApi, update: { update_id: number }) => {
  expect(await waitUntil(() => api.handledOffset > update.update_id)).toBe(
    true,
  );
  expect(await waitUntil(jobsIdle, 10_000)).toBe(true);
};

const postInGroup = async (api: MockBotApi, url = TEST_URL) => {
  const u = api.sendTextMessageToBot(urlMessage(url), MOCK_GROUP_CHAT);
  await settle(api, u);
  return u.message!.message_id;
};

const texts = (api: MockBotApi) =>
  api.sentMessages.flatMap((m) => (m.text ? [m.text] : []));
const videos = (api: MockBotApi) => api.sentMessages.filter((m) => m.video);
const prompts = (api: MockBotApi) =>
  api.sentMessages.filter((m) => m.reply_markup);
const requestsOf = (api: MockBotApi, method: string) =>
  api.requests.filter((r) => r.method === method).map((r) => r.data);

const urlJob = (over: Partial<UrlJob> = {}): UrlJob => ({
  kind: 'url',
  url: TEST_URL,
  chatId: MOCK_USER_ID,
  chatType: 'private',
  messageId: 1,
  fromId: MOCK_USER_ID,
  verbose: false,
  ...over,
});
const groupUrlJob = (url: string) =>
  urlJob({ url, chatId: MOCK_GROUP_CHAT.id, chatType: 'group' });
const confirmedJob = (over: Partial<ConfirmedJob> = {}): ConfirmedJob => ({
  kind: 'confirmed',
  info: video(),
  url: TEST_URL,
  verbose: false,
  messageId: 1,
  chatId: MOCK_USER_ID,
  chatType: 'private',
  postDownload: false,
  ...over,
});

const retryNotice = (n: number) =>
  `⚠️ <b>Download failed</b>, retrying (attempt ${n} of 3)...\n`;
const failure = (reason: string) => `💥 <b>Download failed</b>: ${reason}`;
const promptText = (d: string) =>
  `This video is pretty long (${d}), do you want me to download it anyway?`;

const TRANSIENT_SCRAPE =
  'ERROR: [generic] Unable to download webpage: HTTP Error 503: Service Unavailable';
const TRANSIENT_SCRAPE_REASON =
  'Unable to download webpage: HTTP Error 503: Service Unavailable';
const TRANSIENT_DOWNLOAD =
  'ERROR: unable to download video data: HTTP Error 403: Forbidden';
const TRANSIENT_DOWNLOAD_REASON =
  'unable to download video data: HTTP Error 403: Forbidden';
const SEND_RATE_LIMITED = REAL_ERRORS.sendMessage_rate_limited;
const VIDEO_RATE_LIMITED = REAL_ERRORS.sendVideo_rate_limited;
const BLOCKED = REAL_ERRORS.sendVideo_blocked_by_user;

describe('a private text message', () => {
  it.each([false, true])(
    'persists one job per URL carrying the message fields (edit: %p)',
    (isEdit) =>
      withBotApi(async (api) => {
        await serve();
        await stub({ block: '1' });
        const u = sendText(api, urlMessage(TEST_URL), isEdit);
        expect(await waitUntil(() => api.handledOffset > u.update_id)).toBe(
          true,
        );

        const rows = db.query('SELECT payload FROM jobs').all() as {
          payload: string;
        }[];
        expect(rows.map((r) => JSON.parse(r.payload))).toEqual([
          {
            kind: 'url',
            url: TEST_URL,
            chatId: MOCK_USER_ID,
            chatType: 'private',
            messageId: messageOf(u).message_id,
            fromId: MOCK_USER_ID,
            verbose: false,
          },
        ]);
        await unblockStub();
        await settle(api, u);
      }),
  );

  it.each([false, true])(
    'replies with the progress log, then the video (edit: %p)',
    (isEdit) =>
      withBotApi(async (api) => {
        await serve();
        const u = sendText(api, urlMessage(TEST_URL), isEdit);
        await settle(api, u);

        const replyTo = { message_id: messageOf(u).message_id };
        const [log] = api.sentMessages;
        expect(log!.reply_parameters).toEqual(replyTo);
        expect(log!.text).toContain(`🧐 <b>Scraping</b> ${TEST_URL}...`);
        expect(log!.text).toContain('🎬 <b>Video info:</b>');
        expect(log!.text).toContain('⬇️ <b>Downloading...</b>');
        expect(log!.text).toContain('🚀 <b>Uploading');
        expect(videos(api)).toEqual([
          expect.objectContaining({
            chat_id: MOCK_USER_ID,
            reply_parameters: replyTo,
          }),
        ]);
      }),
  );

  it.each([false, true])(
    'prepends a scheme to a host that merely starts with "http" (edit: %p)',
    (isEdit) =>
      withBotApi(async (api) => {
        await serve();
        await settle(
          api,
          sendText(api, urlMessage('httpbin.org/clip'), isEdit),
        );
        expect(await scrapes()).toEqual([
          expect.stringContaining('yt-dlp https://httpbin.org/clip '),
        ]);
      }),
  );

  it.each([false, true])(
    'sends a URL pasted twice in one message only once (edit: %p)',
    (isEdit) =>
      withBotApi(async (api) => {
        await serve();
        const text = `${TEST_URL} ${TEST_URL}`;
        const u = sendText(
          api,
          {
            text,
            entities: [
              { type: 'url', offset: 0, length: TEST_URL.length },
              {
                type: 'url',
                offset: TEST_URL.length + 1,
                length: TEST_URL.length,
              },
            ],
          },
          isEdit,
        );
        await settle(api, u);
        expect(videos(api)).toHaveLength(1);
      }),
  );

  it.each([false, true])(
    'reports an enqueue failure to the user (edit: %p)',
    (isEdit) =>
      withBotApi(async (api) => {
        let u!: { update_id: number };
        await withFailingWrite('jobs', 'INSERT', async () => {
          u = sendText(api, urlMessage(TEST_URL), isEdit);
          await settle(api, u);
        });
        expect(consoleError).toHaveBeenCalledWith(
          'Failed to enqueue download:',
          expect.any(Error),
        );
        expect(api.sentMessages).toEqual([
          expect.objectContaining({
            chat_id: MOCK_USER_ID,
            text: failure('ENOSPC'),
            reply_parameters: { message_id: messageOf(u).message_id },
          }),
        ]);
        expect(await stubSpawns()).toEqual([]);
      }),
  );

  it('retries a transient failure in one progress message, then reports the reason', () =>
    withBotApi(async (api) => {
      await failScrape(TRANSIENT_SCRAPE);
      await settle(api, api.sendTextMessageToBot(urlMessage(TEST_URL)));

      expect(await scrapes()).toHaveLength(3);
      const [log, ...rest] = texts(api);
      expect(rest).toEqual([]);
      expect(log).toContain(`\n${retryNotice(2)}`);
      expect(log).toContain(`\n${retryNotice(3)}`);
      expect(log).toEndWith(failure(TRANSIENT_SCRAPE_REASON));
    }));

  it('still logs the original error when reporting to the user fails', () =>
    withBotApi(async (api) => {
      await failScrape('ERROR: Unsupported URL: https://example.com');
      api.failNext(SEND_RATE_LIMITED, Infinity);
      await settle(api, api.sendTextMessageToBot(urlMessage(TEST_URL)));

      expect(api.sentMessages).toEqual([]);
      expect(consoleError).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'YtdlpError',
          message: 'Unsupported URL: https://example.com',
        }),
      );
    }));

  it.each([false, true])(
    'ignores a message without links (edit: %p)',
    (isEdit) =>
      withBotApi(async (api) => {
        const u = isEdit
          ? api.sendEditedMessageToBot({ message_id: 42, text: 'hi' })
          : api.sendTextMessageToBot({ text: 'hi' });
        await settle(api, u);
        expect(await stubSpawns()).toEqual([]);
        expect(api.sentMessages).toEqual([]);
        expect(rowCount('handled_urls')).toBe(0);
      }),
  );

  it('downloads a video over 20 min without asking', () =>
    withBotApi(async (api) => {
      await serve(video({ duration: LONG }));
      await settle(api, api.sendTextMessageToBot(urlMessage(TEST_URL)));
      expect(videos(api)).toHaveLength(1);
      expect(prompts(api)).toEqual([]);
    }));

  it('uploads an unknown-duration video without asking, storing its probed duration', () =>
    withBotApi(async (api) => {
      await serve();
      await armProbe(LONG);
      await settle(api, api.sendTextMessageToBot(urlMessage(TEST_URL)));
      expect(videos(api)).toHaveLength(1);
      expect(prompts(api)).toEqual([]);
      expect(getBlob(video())?.duration).toBe(LONG);
    }));
});

it('runs a /verbose request with the yt-dlp output streamed to the chat', () =>
  withBotApi(async (api) => {
    await serve();
    await stub({ stderr: '[debug] Command-line config\n' });
    const { text, entities } = payloads.payloads.dm_verbose_command.message;
    await settle(
      api,
      api.sendTextMessageToBot({ text, entities: entities as any }),
    );
    expect(await scrapes()).toEqual([
      expect.stringContaining(`yt-dlp ${TEST_URL} --verbose `),
    ]);
    expect(texts(api).join('')).toContain(
      '<code>[debug] Command-line config</code>',
    );
    expect(videos(api)).toHaveLength(1);
  }));

it('stays silent on an enqueue failure in a group chat', () =>
  withBotApi(async (api) => {
    await withFailingWrite('jobs', 'INSERT', async () => {
      await postInGroup(api);
    });
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to enqueue download:',
      expect.any(Error),
    );
    expect(api.sentMessages).toEqual([]);
  }));

describe('edited-message dedup (handled_urls)', () => {
  const post = async (api: MockBotApi, url = TEST_URL) => {
    const u = api.sendTextMessageToBot(urlMessage(url));
    await settle(api, u);
    return u.message!.message_id;
  };
  const edit = (api: MockBotApi, message_id: number, url = TEST_URL) =>
    settle(api, api.sendEditedMessageToBot({ message_id, ...urlMessage(url) }));

  it('does not re-send for an edit that keeps the same URL (e.g. a typo fix)', () =>
    withBotApi(async (api) => {
      await serve();
      await edit(api, await post(api));
      expect(videos(api)).toHaveLength(1);
      expect(await scrapes()).toHaveLength(1);
    }));

  it('treats a scheme-variant of a handled URL as the same video', () =>
    withBotApi(async (api) => {
      await serve();
      await edit(api, await post(api, 'example.com'), TEST_URL);
      expect(videos(api)).toHaveLength(1);
      expect(await scrapes()).toEqual([
        expect.stringContaining(`yt-dlp ${TEST_URL} `),
      ]);
    }));

  it('handles a message and its edit dispatched in one batch once', () =>
    withBotApi(async (api) => {
      await serve();
      const original = api.sendTextMessageToBot(urlMessage(TEST_URL));
      const edited = api.sendEditedMessageToBot({
        message_id: original.message!.message_id,
        ...urlMessage(TEST_URL),
      });
      await settle(api, edited);
      expect(videos(api)).toHaveLength(1);
    }));

  it('processes the new URL when an edit changes it', () =>
    withBotApi(async (api) => {
      await serve();
      await edit(api, await post(api), 'https://changed.example');
      expect(videos(api)).toHaveLength(2);
      expect(await scrapes()).toContainEqual(
        expect.stringContaining('yt-dlp https://changed.example '),
      );
    }));

  it('un-records a terminally failed URL so an edit retries it', () =>
    withBotApi(async (api) => {
      await failScrape('ERROR: Unsupported URL: https://example.com');
      await edit(api, await post(api));
      expect(await scrapes()).toHaveLength(2);
    }));

  it('un-records on a too-large estimate verdict so an edit retries it', () =>
    withBotApi(async (api) => {
      await serve(video({ filesize: tooBig }));
      await edit(api, await post(api));
      expect(
        texts(api).filter((t) => t.includes('Video too large')),
      ).toHaveLength(2);
      expect(await downloads()).toEqual([]);
    }));

  it('un-records when the real bytes overshoot, so an edit re-downloads and sends', () =>
    withBotApi(async (api) => {
      await serve();
      await seedOversize(video());
      const id = await post(api);
      expect(
        texts(api).some((t) => t.includes('😞 Video too large (2001.00 MB)')),
      ).toBe(true);
      expect(videos(api)).toEqual([]);

      await edit(api, id);
      expect(videos(api)).toHaveLength(1);
      expect(await downloads()).toHaveLength(1);
    }));

  it('does not mark a URL handled when its enqueue failed (the edit can retry it)', () =>
    withBotApi(async (api) => {
      await serve();
      let id!: number;
      await withFailingWrite('jobs', 'INSERT', async () => {
        id = await post(api);
      });
      await edit(api, id);
      expect(videos(api)).toHaveLength(1);
    }));
});

describe('oversize estimate', () => {
  it('rejects an oversize estimate up front, without downloading', () =>
    withBotApi(async (api) => {
      await serve(video({ filesize_approx: tooBig }));
      await settle(api, api.sendTextMessageToBot(urlMessage(TEST_URL)));
      expect(texts(api)[0]).toContain('😞 Video too large (3072.00 MB)');
      expect(await downloads()).toEqual([]);
      expect(videos(api)).toEqual([]);
    }));

  it('stays silent on an oversize estimate in a group chat', () =>
    withBotApi(async (api) => {
      await serve(video({ filesize_approx: tooBig }));
      await postInGroup(api);
      expect(await downloads()).toEqual([]);
      expect(api.sentMessages).toEqual([]);
    }));

  it('never offers to download an oversize long video in a group chat', () =>
    withBotApi(async (api) => {
      await serve(video({ duration: LONG, filesize_approx: tooBig }));
      await postInGroup(api);
      expect(await downloads()).toEqual([]);
      expect(api.sentMessages).toEqual([]);
    }));
});

describe('inline queries', () => {
  const ask = async (api: MockBotApi, query = TEST_URL) => {
    await settle(api, api.sendInlineQueryToBot(query));
    return api.answeredInlineQueries.map((a) => a.results);
  };
  const errorArticle = (detail: string) => ({
    type: 'article',
    id: 'error',
    title: 'Failed to process video',
    description: detail,
    input_message_content: {
      message_text: `Failed to process video: ${detail}`,
    },
  });

  it('counts an in-flight query for the shutdown drain (inlineIdle)', () =>
    withBotApi(async (api) => {
      await serve();
      await stub({ block: '1' });
      const u = api.sendInlineQueryToBot(TEST_URL);
      expect(await waitUntil(async () => (await stubSpawns()).length > 0)).toBe(
        true,
      );
      expect(inlineIdle()).toBe(false);

      await unblockStub();
      await settle(api, u);
      expect(inlineIdle()).toBe(true);
      expect(api.answeredInlineQueries).toHaveLength(1);
    }));

  it('uploads to the cache chat and answers with the video variants', () =>
    withBotApi(async (api) => {
      await serve();
      const [results] = await ask(api);

      expect(videos(api)).toEqual([
        expect.objectContaining({ chat_id: INLINE_CACHE_CHAT_ID }),
      ]);
      const video_file_id = getBlob(video())!.file_id;
      const source = { inline_keyboard: [[{ text: 'Source', url: TEST_URL }]] };
      expect(results).toEqual([
        {
          id: '0',
          type: 'video',
          title: 'Send video "Test Video"',
          video_file_id,
          caption: 'Test Video',
          reply_markup: source,
        },
        {
          id: '1',
          type: 'video',
          title: 'Send without caption',
          video_file_id,
          reply_markup: source,
        },
        {
          id: '2',
          type: 'video',
          title: 'Send without source',
          video_file_id,
          caption: 'Test Video',
        },
        {
          id: '3',
          type: 'video',
          title: 'Send without caption or source (no context)',
          video_file_id,
        },
      ]);
    }));

  it('does nothing if the query holds no URL', () =>
    withBotApi(async (api) => {
      expect(await ask(api, 'no url here')).toEqual([]);
      expect(await stubSpawns()).toEqual([]);
    }));

  it('answers with the error when the scrape fails', () =>
    withBotApi(async (api) => {
      await failScrape(
        'ERROR: [generic] Unable to download webpage: HTTP Error 404: Not Found',
      );
      expect(await ask(api)).toEqual([
        [errorArticle('Unable to download webpage: HTTP Error 404: Not Found')],
      ]);
      expect(consoleError).toHaveBeenCalledWith(
        'error while handling inline query:',
        expect.anything(),
      );
    }));

  it('survives a failing error answer', () =>
    withBotApi(async (api) => {
      await failScrape('ERROR: Unsupported URL: https://example.com');
      api.failNext(REAL_ERRORS.answerInlineQuery_query_too_old);
      expect(await ask(api)).toEqual([]);
      expect(consoleError).toHaveBeenCalledWith(
        'Failed to send inline error result:',
        expect.any(Error),
      );
    }));

  it('still answers when the download fails after the scrape resolved', () =>
    withBotApi(async (api) => {
      await stubScrape([video()]);
      await failDownload(TRANSIENT_DOWNLOAD);
      expect(await ask(api)).toEqual([
        [errorArticle(TRANSIENT_DOWNLOAD_REASON)],
      ]);
    }));

  it('answers a shutdown-aborted query with a retry hint, not a resume promise', () =>
    withBotApi(async (api) => {
      await serve();
      await stub({ block: '1' });
      const u = api.sendInlineQueryToBot(TEST_URL);
      expect(await waitUntil(async () => (await stubSpawns()).length > 0)).toBe(
        true,
      );
      abortDownloads();
      try {
        await settle(api, u);
      } finally {
        resetShutdown();
      }
      expect(api.answeredInlineQueries.map((a) => a.results)).toEqual([
        [errorArticle('The bot is restarting, please try again in a moment')],
      ]);
    }));

  it('rejects an oversize video up front, without downloading', () =>
    withBotApi(async (api) => {
      await serve(video({ filesize_approx: tooBig }));
      expect(await ask(api)).toEqual([
        [
          {
            type: 'article',
            id: 'too-large',
            title: 'Video too large',
            description: 'Too large to send (3072.00 MB).',
            input_message_content: {
              message_text: 'Video too large to send (3072.00 MB).',
            },
          },
        ],
      ]);
      expect(await downloads()).toEqual([]);
    }));

  it('answers "too large" and drops the bytes when they exceed the limit post-download', () =>
    withBotApi(async (api) => {
      await stubScrape([video()]);
      await seedOversize(video());
      expect(await ask(api)).toEqual([
        [
          expect.objectContaining({
            type: 'article',
            title: 'Video too large',
            description: 'Too large to send.',
          }),
        ],
      ]);
      expect(await bytesOnDisk(video())).toBe(false);
    }));
});

const promptFor = async (api: MockBotApi) => {
  const linkId = await postInGroup(api);
  const promptId = api.sentMessages.findIndex((m) => m.reply_markup);
  expect(promptId).toBeGreaterThanOrEqual(0);
  const [yes, no] = api.sentMessages[promptId]!.reply_markup.inline_keyboard[0];
  return {
    linkId,
    promptId,
    yes: yes.callback_data as string,
    no: no.callback_data as string,
  };
};
const botMessage = async (api: MockBotApi) => {
  await api.call('sendMessage', { chat_id: MOCK_USER_ID, text: 'Sure?' });
  return api.sentMessages.length - 1;
};
const click = async (
  api: MockBotApi,
  promptId: number,
  data: string,
  user?: { id: number },
) => {
  const u = api.sendCallbackQueryToBot(promptId, data, user);
  await settle(api, u);
  return u;
};
const answerTo = (api: MockBotApi, u: any) =>
  api.answeredCallbacks.find((a) => a.callback_query_id === u.callback_query.id)
    ?.text;
const deleted = (api: MockBotApi) => requestsOf(api, 'deleteMessage');

describe('confirmation for long videos (>20 min) in groups', () => {
  it('leaves no orphaned pending row when the confirmation send fails', () =>
    withBotApi(async (api) => {
      await serve(video({ duration: LONG }));
      api.failNext(SEND_RATE_LIMITED);
      await postInGroup(api);

      const attempts = requestsOf(api, 'sendMessage').filter(
        (m) => m.text === promptText('25m'),
      );
      expect(attempts).toHaveLength(2);
      expect(prompts(api)).toHaveLength(1);
      expect(rowCount('pending')).toBe(1);
    }));

  it('shows confirmation buttons instead of downloading', () =>
    withBotApi(async (api) => {
      await serve(video({ duration: LONG }));
      const { linkId } = await promptFor(api);

      expect(api.sentMessages).toEqual([
        expect.objectContaining({
          chat_id: MOCK_GROUP_CHAT.id,
          text: promptText('25m'),
          reply_parameters: { message_id: linkId },
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '👍 Yes please',
                  callback_data: expect.stringMatching(/^dl:/),
                },
                {
                  text: '👎 No thanks',
                  callback_data: expect.stringMatching(/^no:/),
                },
              ],
            ],
          },
        }),
      ]);
      expect(await downloads()).toEqual([]);
    }));

  it('formats the duration with seconds', () =>
    withBotApi(async (api) => {
      await serve(video({ duration: LONG + 30 }));
      await promptFor(api);
      expect(texts(api)).toEqual([promptText('25m 30s')]);
    }));

  it('downloads a video of 20 min or less immediately', () =>
    withBotApi(async (api) => {
      await serve(video({ duration: 5 * 60 }));
      await postInGroup(api);
      expect(videos(api)).toEqual([
        expect.objectContaining({ chat_id: MOCK_GROUP_CHAT.id }),
      ]);
    }));

  it('asks after the download when the probed duration is long though metadata says short', () =>
    withBotApi(async (api) => {
      await serve(video({ duration: 5 * 60 }));
      await armProbe(LONG);
      await promptFor(api);

      expect(await downloads()).toHaveLength(1);
      expect(videos(api)).toEqual([]);
      expect(texts(api)).toEqual([promptText('25m')]);
      expect(await bytesOnDisk(video())).toBe(true);
      expect(rowCount('handled_urls')).toBe(1);
    }));

  it('sends when the probed duration is short too', () =>
    withBotApi(async (api) => {
      await serve(video({ duration: 5 * 60 }));
      await armProbe(5 * 60);
      await postInGroup(api);
      expect(videos(api)).toHaveLength(1);
    }));

  it('gates on the stored duration BEFORE download when metadata lacks one (uploaded blob, bytes gone)', () =>
    withBotApi(async (api) => {
      recordBlob(video());
      setBlobDuration(video(), LONG);
      setBlobFileId(video(), 'uploaded-file-id');
      await serve();
      await promptFor(api);

      expect(texts(api)).toEqual([promptText('25m')]);
      expect(await stubSpawns()).toEqual([
        expect.stringContaining('--dump-json'),
      ]);
      expect(videos(api)).toEqual([]);
    }));

  describe('button clicks', () => {
    const prompted = async (api: MockBotApi) => {
      await serve(video({ duration: LONG }));
      return promptFor(api);
    };

    it('confirms the download when the requester clicks Yes', () =>
      withBotApi(async (api) => {
        const p = await prompted(api);
        const u = await click(api, p.promptId, p.yes);

        expect(answerTo(api, u)).toBe('Starting download...');
        expect(deleted(api)).toEqual([
          { chat_id: MOCK_GROUP_CHAT.id, message_id: p.promptId },
        ]);
        expect(videos(api)).toEqual([
          expect.objectContaining({
            chat_id: MOCK_GROUP_CHAT.id,
            reply_parameters: { message_id: p.linkId },
          }),
        ]);
      }));

    it('lets a different group member confirm', () =>
      withBotApi(async (api) => {
        const p = await prompted(api);
        const u = await click(api, p.promptId, p.yes, { id: 999 });
        expect(answerTo(api, u)).toBe('Starting download...');
        expect(videos(api)).toHaveLength(1);
      }));

    it('cancels when the requester clicks No', () =>
      withBotApi(async (api) => {
        const p = await prompted(api);
        const u = await click(api, p.promptId, p.no);

        expect(answerTo(api, u)).toBe('Cancelled.');
        expect(deleted(api)).toEqual([
          { chat_id: MOCK_GROUP_CHAT.id, message_id: p.promptId },
        ]);
        expect(await downloads()).toEqual([]);
        expect(videos(api)).toEqual([]);
        expect(rowCount('pending')).toBe(0);
      }));

    it('rejects a cancel from a non-requester without removing the pending row', () =>
      withBotApi(async (api) => {
        const p = await prompted(api);
        const u = await click(api, p.promptId, p.no, { id: 999 });

        expect(answerTo(api, u)).toBe('Only the requester can cancel.');
        expect(deleted(api)).toEqual([]);
        expect(rowCount('pending')).toBe(1);
      }));

    it('treats an authorized cancel as unavailable if a confirm adopted it first', () =>
      withBotApi(async (api) => {
        const p = await prompted(api);
        // the cancel peeks the row, then the confirm adopts it before the
        // cancel's take
        const cancel = api.sendCallbackQueryToBot(p.promptId, p.no);
        const confirm = api.sendCallbackQueryToBot(p.promptId, p.yes);
        await settle(api, confirm);

        expect(answerTo(api, cancel)).toBe(
          'This request is no longer available.',
        );
        expect(answerTo(api, confirm)).toBe('Starting download...');
        expect(videos(api)).toHaveLength(1);
      }));

    it('answers "Something went wrong" when handling throws unexpectedly', () =>
      withBotApi(async (api) => {
        const p = await prompted(api);
        let u: unknown;
        await withFailingWrite('pending', 'DELETE', async () => {
          u = await click(api, p.promptId, p.yes);
        });
        expect(answerTo(api, u)).toBe('Something went wrong.');
        expect(consoleError).toHaveBeenCalledWith(
          'Error handling callback query:',
          expect.any(Error),
        );
      }));

    it('answers silently for malformed callback data', () =>
      withBotApi(async (api) => {
        const u = await click(api, await botMessage(api), 'garbage');
        expect(answerTo(api, u)).toBe('');
        expect(await stubSpawns()).toEqual([]);
      }));

    it('survives a failing answerCbQuery', () =>
      withBotApi(async (api) => {
        api.failNext(REAL_ERRORS.answerCallbackQuery_query_too_old);
        await click(api, await botMessage(api), 'garbage');
        expect(consoleError).toHaveBeenCalledWith(
          'answerCbQuery failed:',
          expect.any(Error),
        );
      }));

    it('answers unavailable for an unknown request id', () =>
      withBotApi(async (api) => {
        const u = await click(api, await botMessage(api), 'dl:nonexistent');
        expect(answerTo(api, u)).toBe('This request is no longer available.');
        expect(await stubSpawns()).toEqual([]);
      }));

    it('leaves the claim clickable when the move into the queue fails', () =>
      withBotApi(async (api) => {
        const p = await prompted(api);
        let first: unknown;
        await withFailingWrite('jobs', 'INSERT', async () => {
          first = await click(api, p.promptId, p.yes);
        });
        expect(answerTo(api, first)).toBe('Something went wrong.');

        const second = await click(api, p.promptId, p.yes);
        expect(answerTo(api, second)).toBe('Starting download...');
        expect(videos(api)).toHaveLength(1);
      }));

    it('answers unavailable on a duplicate confirm', () =>
      withBotApi(async (api) => {
        const p = await prompted(api);
        const first = await click(api, p.promptId, p.yes);
        const second = await click(api, p.promptId, p.yes);
        expect(answerTo(api, first)).toBe('Starting download...');
        expect(answerTo(api, second)).toBe(
          'This request is no longer available.',
        );
        expect(videos(api)).toHaveLength(1);
      }));

    it('keeps retries of a confirmed download silent in a group, reporting only the terminal failure', () =>
      withBotApi(async (api) => {
        const p = await prompted(api);
        await failDownload(TRANSIENT_DOWNLOAD);
        const u = await click(api, p.promptId, p.yes);

        expect(answerTo(api, u)).toBe('Starting download...');
        expect(await downloads()).toHaveLength(3);
        expect(texts(api)).toEqual([
          promptText('25m'),
          failure(TRANSIENT_DOWNLOAD_REASON),
        ]);
      }));

    it('answers unavailable on a duplicate cancel', () =>
      withBotApi(async (api) => {
        const p = await prompted(api);
        const first = await click(api, p.promptId, p.no);
        const second = await click(api, p.promptId, p.no);
        expect(answerTo(api, first)).toBe('Cancelled.');
        expect(answerTo(api, second)).toBe(
          'This request is no longer available.',
        );
      }));
  });
});

describe('post-download duration check in groups', () => {
  const unknownLength = async (probed = LONG) => {
    await serve();
    await armProbe(probed);
  };

  it('releases the blob and the pending row when a post-download confirmation send fails', () =>
    withBotApi(async (api, bot) => {
      await unknownLength();
      api.failNext(SEND_RATE_LIMITED);

      // before the final attempt, only the prompt's own cleanup can have
      // released anything
      await expect(
        processJob(bot.telegram, groupUrlJob(TEST_URL), 1),
      ).rejects.toThrow(SEND_RATE_LIMITED.body.description);
      expect(requestsOf(api, 'sendMessage')).toEqual([
        expect.objectContaining({ text: promptText('25m') }),
      ]);
      expect(rowCount('pending')).toBe(0);
      expect(getBlob(video())).toBeNull();
      expect(await bytesOnDisk(video())).toBe(false);
    }));

  it('downloads, then asks when the duration is unknown and ffprobe finds >20 min', () =>
    withBotApi(async (api) => {
      await unknownLength();
      const { linkId } = await promptFor(api);

      expect(await downloads()).toHaveLength(1);
      expect(videos(api)).toEqual([]);
      expect(api.sentMessages).toEqual([
        expect.objectContaining({
          text: promptText('25m'),
          reply_parameters: { message_id: linkId },
        }),
      ]);
      expect(api.sentMessages[0]!.reply_markup.inline_keyboard[0]).toHaveLength(
        2,
      );
    }));

  it('asks before downloading when the duration is 0 and a past probe stored >20 min', () =>
    withBotApi(async (api) => {
      await serve(video({ duration: 0 }));
      recordBlob(video());
      setBlobDuration(video(), LONG);
      await promptFor(api);
      expect(await downloads()).toEqual([]);
    }));

  it('downloads, then asks when the duration is 0 and ffprobe finds >20 min', () =>
    withBotApi(async (api) => {
      await serve(video({ duration: 0 }));
      await armProbe(LONG);
      await promptFor(api);
      expect(await downloads()).toHaveLength(1);
      expect(videos(api)).toEqual([]);
    }));

  it('parks the probed duration without the sponsor chapters it already excludes', () =>
    withBotApi(async (api) => {
      await serve(
        video({
          sponsorblock_chapters: [
            {
              start_time: 0,
              end_time: 60,
              category: 'sponsor',
              title: 'Sponsor',
              type: 'skip',
            },
          ],
        }),
      );
      await armProbe(LONG);
      await promptFor(api);
      const { payload } = db.query('SELECT payload FROM pending').get() as {
        payload: string;
      };
      const parked = JSON.parse(payload).info;
      expect(parked.duration).toBe(LONG);
      expect(parked.sponsorblock_chapters).toBeUndefined();
    }));

  it('downloads and uploads when the duration is unknown and ffprobe finds <=20 min', () =>
    withBotApi(async (api) => {
      await unknownLength(5 * 60);
      await postInGroup(api);
      expect(videos(api)).toHaveLength(1);
    }));

  it('re-probes and stores when a crash left the blob row without a duration', () =>
    withBotApi(async (api) => {
      await seedBytes(video());
      await unknownLength();
      await promptFor(api);

      expect(await downloads()).toEqual([]);
      expect(await probes()).toHaveLength(1);
      expect(videos(api)).toEqual([]);
      expect(getBlob(video())?.duration).toBe(LONG);
    }));

  it('downloads and uploads when the duration is unknown and ffprobe fails', () =>
    withBotApi(async (api) => {
      await serve();
      await failProbe();
      await postInGroup(api);
      expect(videos(api)).toHaveLength(1);
    }));

  it('uploads on confirm without downloading again', () =>
    withBotApi(async (api) => {
      await unknownLength();
      const p = await promptFor(api);
      const u = await click(api, p.promptId, p.yes);

      expect(answerTo(api, u)).toBe('Starting download...');
      expect(videos(api)).toHaveLength(1);
      expect(await downloads()).toHaveLength(1);
    }));

  it('releases the blob, and does not upload, on cancel', () =>
    withBotApi(async (api) => {
      await unknownLength();
      const p = await promptFor(api);
      const u = await click(api, p.promptId, p.no);

      expect(answerTo(api, u)).toBe('Cancelled.');
      expect(videos(api)).toEqual([]);
      expect(getBlob(video())).toBeNull();
      expect(await bytesOnDisk(video())).toBe(false);
    }));
});

describe('confirmed job stale-info refresh', () => {
  it('re-resolves the URL when no blob exists yet', () =>
    withBotApi(async (api, bot) => {
      await serve(video({ width: 640, height: 360 }));
      await processJob(
        bot.telegram,
        confirmedJob({ info: video({ title: 'Old Snapshot' }) }),
        1,
      );
      expect(await scrapes()).toEqual([
        expect.stringContaining(`yt-dlp ${TEST_URL} `),
      ]);
      expect(videos(api)).toEqual([
        expect.objectContaining({ width: 640, height: 360 }),
      ]);
    }));

  it('reuses an existing blob without re-resolving', () =>
    withBotApi(async (api, bot) => {
      const info = video({ id: 'has-blob' });
      recordBlob(info);
      setBlobFileId(info, 'cached-file-id');
      api.fileIds.set('cached-file-id', '/storage/earlier-upload.mp4');

      await processJob(
        bot.telegram,
        confirmedJob({ info, postDownload: true }),
        1,
      );
      expect(await stubSpawns()).toEqual([]);
      expect(videos(api)).toEqual([
        expect.objectContaining({ video: 'cached-file-id' }),
      ]);
    }));

  it('downloads again when a parked post-download blob was released', () =>
    withBotApi(async (api, bot) => {
      await serve();
      await processJob(bot.telegram, confirmedJob({ postDownload: true }), 1);
      expect(await downloads()).toHaveLength(1);
      expect(videos(api)).toHaveLength(1);
    }));
});

describe('confirmed job oversize report', () => {
  it('un-records a lone confirmed video that turns out too large', () =>
    withBotApi(async (api, bot) => {
      const url = 'https://example.com/lone';
      seedHandledUrl(MOCK_USER_ID, 1, url);
      await seedOversize(video());

      await processJob(bot.telegram, confirmedJob({ url }), 1);

      expect(texts(api)).toEqual(['😞 Video too large to send.']);
      expect(rowCount('handled_urls')).toBe(0);
    }));

  it('reports too-large in a group when the real bytes overshoot, releasing the parked and the drifted blob', () =>
    withBotApi(async (api, bot) => {
      const parked = video({ format_id: 'parked' });
      const drifted = video({ format_id: 'drifted' });
      recordBlob(parked);
      await stubScrape([drifted]);
      await seedOversize(drifted);

      await expect(
        processJob(
          bot.telegram,
          confirmedJob({
            chatId: MOCK_GROUP_CHAT.id,
            chatType: 'group',
            info: parked,
          }),
          1,
        ),
      ).resolves.toBeUndefined();

      expect(api.sentMessages).toEqual([
        expect.objectContaining({
          chat_id: MOCK_GROUP_CHAT.id,
          text: '😞 Video too large to send.',
        }),
      ]);
      expect(getBlob(parked)).toBeNull();
      expect(getBlob(drifted)).toBeNull();
      expect(await bytesOnDisk(drifted)).toBe(false);
    }));
});

describe('job retry classification', () => {
  const logMessage = (api: MockBotApi) => {
    const id = api.sentMessages.findIndex((m) => m.text);
    return { id, text: api.sentMessages[id]?.text };
  };

  it('rethrows a shutdown abort silently, stashing the flushed log pointer for the re-run', () =>
    withBotApi(async (api, bot) => {
      await serve();
      await stub({ block: '1' });
      const job = urlJob();
      const run = processJob(bot.telegram, job, 1).catch((e) => e);
      expect(await waitUntil(async () => (await stubSpawns()).length > 0)).toBe(
        true,
      );
      abortDownloads();
      try {
        expect((await run).name).toBe('ShutdownAbort');
      } finally {
        resetShutdown();
      }

      const log = logMessage(api);
      expect(log.text).toBe(`🧐 <b>Scraping</b> ${TEST_URL}...`);
      expect(job.logMessageId).toBe(log.id);
      expect(job.logText).toBe(log.text);
    }));

  it('re-prints the info block only when the delivered thread lacks it', () =>
    withBotApi(async (api, bot) => {
      await serve();
      const infoBlocks = () =>
        texts(api).filter((t) => t.includes('🎬 <b>Video info:</b>')).length;

      const undelivered = urlJob({ logText: '🧐 <b>Scraping</b> x...' });
      await processJob(bot.telegram, undelivered, 2);
      expect(undelivered.infoShown).toBe(true);
      expect(infoBlocks()).toBe(1);

      const thread = logMessage(api);
      const j2 = urlJob({
        logMessageId: thread.id,
        logText: thread.text,
        infoShown: true,
      });
      await processJob(bot.telegram, j2, 2);
      expect(api.sentMessages[thread.id]!.text).toBe(thread.text!);
      expect(infoBlocks()).toBe(1);

      const j3 = urlJob({ logMessageId: undefined, infoShown: true });
      await processJob(bot.telegram, j3, 2);
      expect(infoBlocks()).toBe(2);
      expect(videos(api)).toHaveLength(3);
    }));

  it('rethrows a retryable error, reports ⚠️, and saves the message pointer for the retry', () =>
    withBotApi(async (api, bot) => {
      await failScrape(TRANSIENT_SCRAPE);
      const job = urlJob();
      await expect(processJob(bot.telegram, job, 1)).rejects.toThrow(
        TRANSIENT_SCRAPE_REASON,
      );
      const log = logMessage(api);
      expect(log.text).toEndWith(`\n${retryNotice(2)}`);
      expect(job.logMessageId).toBe(log.id);
      expect(job.logText).toBe(log.text);
    }));

  it('does not retry a permanent (unsupported-URL) error, reporting 💥', () =>
    withBotApi(async (api, bot) => {
      await failScrape('ERROR: Unsupported URL: https://example.com');
      await expect(
        processJob(bot.telegram, urlJob(), 1),
      ).resolves.toBeUndefined();
      expect(logMessage(api).text).toEndWith(
        `\n${failure('Unsupported URL: https://example.com')}`,
      );
    }));

  it('does not retry a permanent Telegram error (bot blocked), reporting 💥', () =>
    withBotApi(async (api, bot) => {
      await serve();
      api.failNext(BLOCKED);
      await expect(
        processJob(bot.telegram, urlJob(), 1),
      ).resolves.toBeUndefined();
      expect(logMessage(api).text).toEndWith(
        failure(`403: ${BLOCKED.body.description}`),
      );
    }));

  it('stops retrying on the final attempt, reporting 💥', () =>
    withBotApi(async (api, bot) => {
      await failScrape(TRANSIENT_SCRAPE);
      await expect(
        processJob(bot.telegram, urlJob(), 3),
      ).resolves.toBeUndefined();
      expect(logMessage(api).text).toEndWith(failure(TRANSIENT_SCRAPE_REASON));
    }));

  it('keeps the cached info when only the send fails', () =>
    withBotApi(async (api, bot) => {
      await serve();
      api.failNext(VIDEO_RATE_LIMITED);
      await processJob(bot.telegram, urlJob(), 3);
      expect(rowCount('video_info')).toBe(1);
    }));

  it('evicts the cached info when yt-dlp fails the download', () =>
    withBotApi(async (_api, bot) => {
      await stubScrape([video()]);
      await failDownload(TRANSIENT_DOWNLOAD);
      await processJob(bot.telegram, urlJob(), 3);
      expect(rowCount('video_info')).toBe(0);
    }));

  it('reports a private confirmed-job retry (reasonless) and saves the message id', () =>
    withBotApi(async (api, bot) => {
      await stubScrape([video()]);
      await failDownload(TRANSIENT_DOWNLOAD);
      const job = confirmedJob();
      await expect(processJob(bot.telegram, job, 1)).rejects.toThrow(
        TRANSIENT_DOWNLOAD_REASON,
      );
      expect(texts(api)).toEqual([retryNotice(2)]);
      expect(job.logMessageId).toBe(logMessage(api).id);
    }));

  it('says nothing in a group when the reply target was deleted', () =>
    withBotApi(async (api, bot) => {
      await serve();
      const job = confirmedJob({
        chatId: MOCK_GROUP_CHAT.id,
        chatType: 'group',
        messageId: GONE_REPLY_ID,
      });
      await expect(processJob(bot.telegram, job, 1)).resolves.toBeUndefined();
      expect(requestsOf(api, 'sendVideo')).toHaveLength(1);
      expect(api.sentMessages).toEqual([]);
    }));

  it('un-records the originating URL when a confirmed job fails terminally', () =>
    withBotApi(async (_api, bot) => {
      seedHandledUrl(MOCK_USER_ID, 1, 'https://typed.example');
      await stubScrape([video()]);
      await failDownload('ERROR: Unsupported URL: https://example.com');
      await expect(
        processJob(
          bot.telegram,
          confirmedJob({ url: 'https://typed.example' }),
          1,
        ),
      ).resolves.toBeUndefined();
      expect(rowCount('handled_urls')).toBe(0);
    }));

  describe('a confirmed job whose re-resolve drifts the format', () => {
    const parked = video({ format_id: 'orig' });
    const drifted = video({ format_id: 'drifted' });
    const park = async () => {
      recordBlob(parked);
      await stubScrape([drifted]);
    };

    it('releases the parked blob when the download fails', () =>
      withBotApi(async (_api, bot) => {
        await park();
        await failDownload('ERROR: Unsupported URL: https://example.com');
        await expect(
          processJob(bot.telegram, confirmedJob({ info: parked }), 1),
        ).resolves.toBeUndefined();
        expect(getBlob(parked)).toBeNull();
      }));

    it('releases the parked blob when the send finds the bytes too large', () =>
      withBotApi(async (api, bot) => {
        await park();
        await seedOversize(drifted);
        await expect(
          processJob(bot.telegram, confirmedJob({ info: parked }), 1),
        ).resolves.toBeUndefined();
        expect(texts(api)).toEqual(['😞 Video too large to send.']);
        expect(getBlob(parked)).toBeNull();
      }));

    it('releases the parked blob on a fully successful send', () =>
      withBotApi(async (api, bot) => {
        await park();
        await armDownload();
        await expect(
          processJob(bot.telegram, confirmedJob({ info: parked }), 1),
        ).resolves.toBeUndefined();
        expect(videos(api)).toHaveLength(1);
        expect(getBlob(parked)).toBeNull();
      }));
  });

  it('keeps group retries of a confirmed job silent; only the terminal report posts', () =>
    withBotApi(async (api, bot) => {
      await stubScrape([video()]);
      await failDownload(TRANSIENT_DOWNLOAD);
      const job = confirmedJob({
        chatId: MOCK_GROUP_CHAT.id,
        chatType: 'group',
      });
      await expect(processJob(bot.telegram, job, 1)).rejects.toThrow(
        TRANSIENT_DOWNLOAD_REASON,
      );
      expect(api.sentMessages).toEqual([]);
      await expect(processJob(bot.telegram, job, 3)).resolves.toBeUndefined();
      expect(texts(api)).toEqual([failure(TRANSIENT_DOWNLOAD_REASON)]);
    }));
});

describe('group terminal-failure feedback', () => {
  const expectOneReport = (api: MockBotApi, linkId: number, reason: string) =>
    expect(api.sentMessages).toEqual([
      expect.objectContaining({
        chat_id: MOCK_GROUP_CHAT.id,
        text: failure(reason),
        reply_parameters: { message_id: linkId },
      }),
    ]);

  it('gives a not-a-video error exactly one attempt (no retry) in private chat', () =>
    withBotApi(async (api, bot) => {
      await failScrape('ERROR: [Reddit] 92dd8: No media found');
      await expect(
        processJob(
          bot.telegram,
          urlJob({ url: 'https://reddit.com/r/x/comments/y' }),
          1,
        ),
      ).resolves.toBeUndefined();
      const [log] = texts(api);
      expect(log).toContain('💥 <b>Download failed</b>:');
      expect(log).not.toContain('retrying');
    }));

  it('stays silent on a scrape failure for a non-whitelisted host', () =>
    withBotApi(async (api) => {
      await failScrape('ERROR: Video unavailable');
      await postInGroup(api, 'https://news.example.com/article');
      expect(api.sentMessages).toEqual([]);
    }));

  it('reports one 💥 for a terminal non-not-a-video Instagram scrape failure', () =>
    withBotApi(async (api) => {
      await failScrape(
        'ERROR: [Instagram] xyz: Requested content is not available, rate-limit reached or login required',
      );
      const linkId = await postInGroup(api, 'https://www.instagram.com/p/xyz');
      expect(await scrapes()).toHaveLength(3);
      expectOneReport(
        api,
        linkId,
        'xyz: Requested content is not available, rate-limit reached or login required',
      );
    }));

  it('whitelists a trailing-dot host (reddit.com.) for the terminal report', () =>
    withBotApi(async (api) => {
      await failScrape('ERROR: Video unavailable');
      const linkId = await postInGroup(
        api,
        'https://reddit.com./r/x/comments/y',
      );
      expectOneReport(api, linkId, 'Video unavailable');
    }));

  it.each([
    [
      'https://www.instagram.com/p/DbHhjdBJT9O',
      'ERROR: [Instagram] DbHhjdBJT9O: There is no video in this post',
    ],
    [
      'https://www.reddit.com/r/x/comments/y',
      'ERROR: [Reddit] 92dd8: No media found',
    ],
  ])('stays silent for a whitelisted not-a-video (%j)', (url, stderr) =>
    withBotApi(async (api) => {
      await failScrape(stderr);
      await postInGroup(api, url);
      expect(api.sentMessages).toEqual([]);
    }),
  );

  it('treats an unparseable URL as not whitelisted (stays silent)', () =>
    withBotApi(async (api, bot) => {
      await failScrape('ERROR: Video unavailable');
      await expect(
        processJob(bot.telegram, groupUrlJob('https://'), 1),
      ).resolves.toBeUndefined();
      expect(api.sentMessages).toEqual([]);
    }));

  it('reports one 💥 when info resolved then the download fails permanently', () =>
    withBotApi(async (api) => {
      await stubScrape([video()]);
      await failDownload('ERROR: Video unavailable');
      const linkId = await postInGroup(api);
      expectOneReport(api, linkId, 'Video unavailable');
    }));

  it('stays silent when info resolved but the download fails not-a-video', () =>
    withBotApi(async (api) => {
      await stubScrape([video()]);
      await failDownload(
        'ERROR: Unsupported URL: https://example.com/video/sub',
      );
      await postInGroup(api);
      expect(api.sentMessages).toEqual([]);
    }));

  it('stays silent through transient retries, then reports one terminal 💥', () =>
    withBotApi(async (api) => {
      await stubScrape([video()]);
      await failDownload(TRANSIENT_DOWNLOAD);
      const linkId = await postInGroup(api);
      expect(await downloads()).toHaveLength(3);
      expectOneReport(api, linkId, TRANSIENT_DOWNLOAD_REASON);
    }));

  it('reports one 💥 when the send itself fails on every attempt', () =>
    withBotApi(async (api) => {
      await serve();
      api.failNext(VIDEO_RATE_LIMITED, 3);
      const linkId = await postInGroup(api);
      expect(requestsOf(api, 'sendVideo')).toHaveLength(3);
      expectOneReport(
        api,
        linkId,
        `429: ${VIDEO_RATE_LIMITED.body.description}`,
      );
    }));

  it('stays silent on a too-large estimate in a group (no report leaks in)', () =>
    withBotApi(async (api) => {
      const url = 'https://www.instagram.com/p/huge';
      await serve(video({ webpage_url: url, filesize: tooBig }));
      await postInGroup(api, url);
      expect(api.sentMessages).toEqual([]);
    }));
});

describe('multi-video posts', () => {
  const post = 'https://www.instagram.com/p/carousel';
  const entries = ['a', 'b', 'c'].map((id) =>
    video({
      webpage_url: post,
      title: `Video ${id}`,
      extractor: 'Instagram',
      id,
      filename: `${id}.mp4`,
    }),
  );
  const armLimitStop = () =>
    stubScrape(entries.slice(0, VIDEOS_TO_DECIDE), {
      exit: String(MAX_DOWNLOADS_REACHED),
    });

  it('tells a private chat it only sends single-video links, and sends nothing', () =>
    withBotApi(async (api) => {
      await armLimitStop();
      await armDownload();
      await settle(api, api.sendTextMessageToBot(urlMessage(post)));
      expect(texts(api)).toEqual([
        `🧐 <b>Scraping</b> ${post}...\n\n📚 This post has several videos. I only send links with a single video.`,
      ]);
      expect(await downloads()).toEqual([]);
      expect(videos(api)).toEqual([]);
    }));

  it('lets an edit retry a multi-video link', () =>
    withBotApi(async (api) => {
      await armLimitStop();
      const u = api.sendTextMessageToBot(urlMessage(post));
      await settle(api, u);
      await settle(
        api,
        api.sendEditedMessageToBot({
          message_id: u.message!.message_id,
          ...urlMessage(post),
        }),
      );
      expect(texts(api).filter((t) => t.includes(SEVERAL_VIDEOS))).toHaveLength(
        2,
      );
    }));

  it('stays silent in a group chat, and sends nothing', () =>
    withBotApi(async (api) => {
      await armLimitStop();
      await armDownload();
      await postInGroup(api, post);
      expect(await scrapes()).toHaveLength(1);
      expect(await downloads()).toEqual([]);
      expect(api.sentMessages).toEqual([]);
    }));

  it('answers an inline query with the first video', () =>
    withBotApi(async (api) => {
      await armLimitStop();
      await armDownload();
      await armProbe(10);
      await settle(api, api.sendInlineQueryToBot(post));
      expect(await downloads()).toHaveLength(1);
      expect(getBlob(entries[0]!)?.file_id).toBeTruthy();
      expect(getBlob(entries[1]!)).toBeNull();
      expect(api.answeredInlineQueries[0]!.results[0]).toMatchObject({
        type: 'video',
        caption: 'Video a',
      });
    }));

  it('sends the one video of a post whose other items are photos', () =>
    withBotApi(async (api) => {
      await stubScrape([entries[0]!], {
        exit: '1',
        stderr:
          'ERROR: [Instagram] b: No video formats found!\nERROR: [Instagram] c: No video formats found!\n',
      });
      await armDownload();
      await armProbe(30);
      await settle(api, api.sendTextMessageToBot(urlMessage(post)));
      expect(videos(api)).toHaveLength(1);
      expect(getBlob(entries[0]!)?.file_id).toBeTruthy();
      expect(texts(api).join('\n')).not.toContain('📚');
    }));
});
