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
import * as fsPromises from 'node:fs/promises';
import type { Message } from 'telegraf/types';
import * as blobStore from '../src/blob-store.ts';
import { db, resetDb } from '../src/db.ts';
import * as downloadVideo from '../src/download-video.ts';
import {
  callbackQueryHandler,
  inlineIdle,
  inlineQueryHandler,
  processJob,
  textMessageHandler,
} from '../src/handlers';
import * as jobQueue from '../src/job-queue';
import * as logMessage from '../src/log-message.ts';
import * as pendingDownloads from '../src/pending-downloads.ts';
import {
  createMockCallbackCtx,
  createMockMessageCtx,
  memoize,
  rowCount,
  spyMock,
  telegramError,
} from './test-utils.ts';

beforeEach(() => {
  jest.clearAllMocks();
  // Full resetDb (not just clearPending): handled_urls rows would otherwise
  // dedupe away re-used chat/message ids across tests, and blob rows would
  // leak stored durations into the confirmation-gate tests.
  resetDb();
});
afterAll(() => mock.restore());
spyMock(console, 'debug'); // suppress debug logs
// guard: nothing here should hit the real filesystem unlink
spyOn(fsPromises, 'unlink').mockResolvedValue(undefined);

const mockLog = {
  append: mock(),
  flush: mock(),
  messageId: 4242,
  text: 'prior log content',
};
spyOn(logMessage, 'LogMessage').mockReturnValue(mockLog as never);
// logFor constructs LogMessage through log-message's module-internal binding,
// which the constructor spy above can't reach: mock it directly, mirroring
// the real policy (private → the observable mockLog, group → silent)
spyOn(logMessage, 'logFor').mockImplementation((_tg, chatType) =>
  chatType === 'private' ? (mockLog as never) : new logMessage.NoLog(),
);

// run enqueued jobs inline against the invoking ctx's telegram client, so
// the handler tests below exercise the full enqueue→process flow
let bridgeTg: any;
const mockEnqueue = spyOn(jobQueue, 'enqueueJob').mockImplementation(
  async (j, guard) => {
    // honor the guard like the real enqueue: it dedupes (handled_urls) inside
    // the insert tx, and a false return means this enqueue must be skipped
    if (guard && !guard()) return;
    // the queue (not enqueue) runs the job at attempt 1; a retryable error
    // rethrows to signal the queue to retry, so absorb it here
    await processJob(bridgeTg, j, 1).catch(() => {});
  },
);
// adoptJob moves a parked confirmation into the queue; mirror that by taking
// the real pending row and running the confirmed job inline
const mockAdopt = spyOn(jobQueue, 'adoptJob').mockImplementation(
  async (id: string) => {
    const pending = await pendingDownloads.takePending(id);
    if (!pending) return false; // mirrors the real contract: row already gone
    await processJob(bridgeTg, pending, 1).catch(() => {});
    return true;
  },
);
const handle = async (ctx: any) => {
  bridgeTg = ctx.telegram;
  await textMessageHandler(ctx);
};
const handleCb = async (ctx: any) => {
  bridgeTg = ctx.telegram;
  await callbackQueryHandler(ctx);
};

// Helper to create a mock InlineQueryContext
const createMockInlineQueryCtx = (overrides: any = {}) => ({
  inlineQuery: {
    query: 'https://example.com',
    ...overrides.inlineQuery,
  },
  answerInlineQuery: mock(async () => {}),
  ...overrides,
});

// Mock download-video.ts
const mockGetInfo = spyOn(downloadVideo, 'getInfo').mockImplementation(
  memoize(
    mock(async (_log, url, _verbose) => ({
      webpage_url: url,
      title: 'Test Video',
      extractor: 'test',
      playlist_title: 'Playlist',
      id: 'id',
      description: 'desc',
      filename: 'video.mp4',
    })),
  ),
);

const mockSendInfo = spyMock(downloadVideo, 'sendInfo');
const mockDownloadVideo = spyOn(
  downloadVideo,
  'downloadVideo',
).mockResolvedValue('downloaded');
const mockSendVideo = spyOn(downloadVideo, 'sendVideo').mockResolvedValue({
  video: { file_id: 'file123' },
} as Message.VideoMessage);
const mockProbeDuration = spyOn(
  downloadVideo,
  'probeDuration',
).mockResolvedValue(undefined);
// pass through to the real releaseBlob so release calls are observable; tests
// that seed blob rows get the real delete
const mockReleaseBlob = spyOn(blobStore, 'releaseBlob');

const groupChat = { id: -100, type: 'group', title: 'Test Group' };

describe.each([false, true])('textMessageHandler, edit: %p', (isEdit) => {
  it('enqueues one durable job per URL with the message fields', async () => {
    const ctx = createMockMessageCtx(isEdit);
    await handle(ctx as any);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockEnqueue).toHaveBeenCalledWith(
      {
        kind: 'url',
        url: 'https://example.com',
        chatId: 123,
        chatType: 'private',
        messageId: 1,
        fromId: 123,
        verbose: false,
        // the mock ran the job inline, and processUrlJob mutates its job
        // (the mutation is what persists across retries); the recorded call
        // arg is that same object, so the flag shows here
        infoShown: true,
      },
      expect.any(Function), // the handled-urls record, run inside the tx
    );
  });

  it('prepends a scheme only when a real one is missing', async () => {
    // "httpbin.org" merely STARTS with "http", it still needs a scheme
    const text = 'httpbin.org/clip';
    const ctx = createMockMessageCtx(isEdit);
    const msg = (ctx as any).message ?? (ctx as any).editedMessage;
    msg.text = text;
    msg.entities = [{ type: 'url', offset: 0, length: text.length }];
    await handle(ctx as any);
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://httpbin.org/clip' }),
      expect.any(Function),
    );
  });

  it('enqueues a URL pasted twice in one message only once', async () => {
    const text = 'https://example.com https://example.com';
    const ctx = createMockMessageCtx(isEdit);
    const msg = (ctx as any).message ?? (ctx as any).editedMessage;
    msg.text = text;
    msg.entities = [
      { type: 'url', offset: 0, length: 19 },
      { type: 'url', offset: 20, length: 19 },
    ];
    await handle(ctx as any);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
  });

  it('reports enqueue failures to the user', async () => {
    const consoleError = spyMock(console, 'error');
    mockEnqueue.mockImplementationOnce(() =>
      Promise.reject(new Error('disk full')),
    );
    const ctx = createMockMessageCtx(isEdit);
    await handle(ctx as any); // must not throw
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to enqueue download:',
      expect.any(Error),
    );
    // reported through the chat-type-aware log, replying to the original
    // message (logFor is mocked above to hand back mockLog for private chats)
    expect(logMessage.logFor).toHaveBeenCalledWith(
      ctx.telegram,
      'private',
      expect.objectContaining({ replyTo: 1 }),
    );
    expect(mockLog.append).toHaveBeenCalledWith(
      expect.stringContaining('Download failed'),
    );
  });

  it('stays silent on an enqueue failure in a group chat', async () => {
    const consoleError = spyMock(console, 'error');
    mockEnqueue.mockImplementationOnce(() =>
      Promise.reject(new Error('disk full')),
    );
    const ctx = createMockMessageCtx(isEdit, { chat: groupChat });
    await handle(ctx as any); // must not throw
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to enqueue download:',
      expect.any(Error),
    );
    expect(logMessage.LogMessage).not.toHaveBeenCalled();
    expect(ctx.telegram.sendMessage).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('enqueues with fromId 0 when the message has no sender', async () => {
    const ctx = createMockMessageCtx(isEdit, { from: null });
    delete (ctx.message || ctx.editedMessage).from;
    await handle(ctx as any); // must not throw
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ fromId: 0 }),
      expect.any(Function),
    );
  });

  it('handles a message with a URL', async () => {
    const ctx = createMockMessageCtx(isEdit);
    await handle(ctx as any);
    expect(mockGetInfo).toHaveBeenCalled();
    expect(mockSendInfo).toHaveBeenCalled();
    expect(mockDownloadVideo).toHaveBeenCalled();
    expect(mockSendVideo).toHaveBeenCalled();
  });

  it('handles download errors gracefully', async () => {
    const ctx = createMockMessageCtx(isEdit);
    mockGetInfo.mockRejectedValueOnce(new Error('oh noes!'));
    const mockError = spyOn(console, 'error').mockImplementationOnce(() => {});
    await handle(ctx as any);
    expect(mockGetInfo).toHaveBeenCalled();
    expect(mockError).toHaveBeenCalledTimes(1);
    expect(mockLog.append).toHaveBeenCalledWith(
      '\n⚠️ <b>Download failed</b>, retrying (attempt 2 of 3)...\n',
    );
  });

  it('still logs the original error when reporting to the user fails', async () => {
    const ctx = createMockMessageCtx(isEdit);
    mockGetInfo.mockImplementationOnce(() =>
      Promise.reject(new Error('oh noes!')),
    );
    const mockError = spyMock(console, 'error');
    mockLog.flush.mockImplementationOnce(() =>
      Promise.reject(new Error('telegram down')),
    );
    await handle(ctx as any); // must not throw
    const logged = mockError.mock.calls.map(([first]) => first);
    expect(logged).toContainEqual(
      expect.objectContaining({ message: 'oh noes!' }),
    );
  });

  it('reports non-Error throws sensibly', async () => {
    const ctx = createMockMessageCtx(isEdit);
    mockGetInfo.mockImplementationOnce(() => Promise.reject('string error'));
    spyMock(console, 'error');
    await handle(ctx as any);
    expect(mockLog.append).toHaveBeenCalledWith(
      '\n⚠️ <b>Download failed</b>, retrying (attempt 2 of 3)...\n',
    );
  });

  it('does nothing if no url entities', async () => {
    const ctx = createMockMessageCtx(isEdit);
    (ctx.message || ctx.editedMessage).entities = [];
    await handle(ctx);
    // Should not call any download functions
    expect(mockGetInfo).not.toHaveBeenCalled();
  });
});

describe('edited-message dedup (handled_urls)', () => {
  it('does not re-send for an edit that keeps the same URL (e.g. a typo fix)', async () => {
    await handle(createMockMessageCtx(false) as any); // original message
    expect(mockEnqueue).toHaveBeenCalledTimes(1);

    // the edit re-triggers the handler with the same chat/message ids and URL
    await handle(createMockMessageCtx(true) as any);
    expect(mockEnqueue).toHaveBeenCalledTimes(1); // no duplicate video
  });

  it('treats a scheme-variant of a handled URL as the same video', async () => {
    // "example.com" and "https://example.com" normalize to one URL: an edit
    // that merely makes the scheme explicit must not re-send
    const bare = createMockMessageCtx(false);
    const msg = (bare as any).message;
    msg.text = 'example.com';
    msg.entities = [{ type: 'url', offset: 0, length: 11 }];
    await handle(bare as any);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example.com' }),
      expect.any(Function),
    );

    await handle(createMockMessageCtx(true) as any); // edit: https://example.com
    expect(mockEnqueue).toHaveBeenCalledTimes(1); // deduped across the variant
  });

  it('concurrent dispatch of a message and its edit enqueues once', async () => {
    // telegraf dispatches a poll batch with Promise.all; the record lands
    // synchronously before the handler's first await, so the second
    // invocation's pre-check already sees it
    const a = createMockMessageCtx(false);
    const b = createMockMessageCtx(true); // same chat/message/url
    await Promise.all([handle(a as any), handle(b as any)]);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
  });

  it('processes the new URL when an edit changes it', async () => {
    await handle(createMockMessageCtx(false) as any);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);

    const edited = createMockMessageCtx(true);
    const msg = (edited as any).editedMessage;
    msg.text = 'https://changed.example';
    msg.entities = [{ type: 'url', offset: 0, length: msg.text.length }];
    await handle(edited as any);
    expect(mockEnqueue).toHaveBeenCalledTimes(2);
    expect(mockEnqueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: 'https://changed.example' }),
      expect.any(Function),
    );
  });

  it('un-records a terminally failed URL so an edit retries it', async () => {
    // yt-dlp may self-update (or the site recover) after a permanent failure;
    // the edit gesture must reach a fresh job instead of the dedup record
    spyMock(console, 'error');
    mockGetInfo.mockRejectedValueOnce(
      new downloadVideo.YtdlpError(
        'failed',
        'ERROR: Unsupported URL: https://example.com',
      ),
    );
    await handle(createMockMessageCtx(false) as any);
    expect(mockEnqueue).toHaveBeenCalledTimes(1); // ran, failed terminally

    await handle(createMockMessageCtx(true) as any); // the edit retries
    expect(mockEnqueue).toHaveBeenCalledTimes(2); // not deduped away
  });

  it('un-records on a too-large estimate verdict so an edit retries it', async () => {
    // estimates are unreliable and formats change: the verdict is terminal
    // for this message, so the edit gesture must reach a fresh job
    mockGetInfo.mockImplementationOnce(async (_log, url) => ({
      webpage_url: url,
      title: 'Huge',
      filename: 'huge.mp4',
      filesize: 3000 * 1024 * 1024,
    }));
    await handle(createMockMessageCtx(false) as any);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);

    await handle(createMockMessageCtx(true) as any); // the edit retries
    expect(mockEnqueue).toHaveBeenCalledTimes(2);
  });

  it('un-records when the real bytes overshoot (sendVideo returns undefined)', async () => {
    // a missing/under estimate slips past tooLargeToSend, then sendVideo finds
    // the real on-disk bytes too large and returns undefined; that too-large
    // verdict is terminal, so the edit gesture must reach a fresh job
    mockSendVideo.mockResolvedValueOnce(undefined as any);
    await handle(createMockMessageCtx(false) as any);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);

    await handle(createMockMessageCtx(true) as any); // the edit retries
    expect(mockEnqueue).toHaveBeenCalledTimes(2);
  });

  it('does not mark a URL handled when its enqueue failed (the edit can retry it)', async () => {
    spyMock(console, 'error');
    mockEnqueue.mockImplementationOnce(() =>
      Promise.reject(new Error('disk full')),
    );
    await handle(createMockMessageCtx(false) as any);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);

    await handle(createMockMessageCtx(true) as any); // the edit retries
    expect(mockEnqueue).toHaveBeenCalledTimes(2);
  });
});

describe('processUrlJob oversize rejection', () => {
  const oversize = () =>
    mockGetInfo.mockResolvedValueOnce({
      webpage_url: 'https://example.com',
      title: 'Huge',
      filename: 'huge.mp4',
      filesize_approx: 3 * 1024 * 1024 * 1024, // 3 GB > the 2 GB send limit
    } as any);

  it('rejects an oversize estimate up front, without downloading', async () => {
    oversize();
    const ctx = createMockMessageCtx(false);
    await handle(ctx as any);
    expect(mockDownloadVideo).not.toHaveBeenCalled();
    expect(mockSendVideo).not.toHaveBeenCalled();
    expect(mockLog.append).toHaveBeenCalledWith(
      expect.stringContaining('Video too large'),
    );
  });

  it('stays silent on an oversize estimate in a group chat', async () => {
    oversize();
    const ctx = createMockMessageCtx(false, { chat: groupChat });
    await handle(ctx as any);
    expect(mockDownloadVideo).not.toHaveBeenCalled();
    expect(mockSendVideo).not.toHaveBeenCalled();
    // a group's NoLog reports nothing: no message, no confirmation prompt
    expect(ctx.telegram.sendMessage).not.toHaveBeenCalled();
  });
});

describe('inlineQueryHandler', () => {
  it('counts an in-flight query for the shutdown drain (inlineIdle)', async () => {
    // inline work has no durable job row: the drain hold (bot.ts) must wait
    // on this counter or the process could exit mid-upload and lose the query
    let release!: (info: any) => void;
    mockGetInfo.mockImplementationOnce(
      () => new Promise((r) => (release = r)),
    );
    const ctx = createMockInlineQueryCtx();
    const inFlight = inlineQueryHandler(ctx as any);
    expect(inlineIdle()).toBe(false);
    release({
      webpage_url: 'https://example.com',
      title: 'T',
      filename: 'v.mp4',
    });
    await inFlight;
    expect(inlineIdle()).toBe(true);
  });

  it('handles an inline query with a URL', async () => {
    const ctx = createMockInlineQueryCtx();
    await inlineQueryHandler(ctx as any);
    expect(mockGetInfo).toHaveBeenCalled();
    expect(mockDownloadVideo).toHaveBeenCalled();
    expect(mockSendVideo).toHaveBeenCalled();
    expect(ctx.answerInlineQuery).toHaveBeenCalled();
  });

  it('does nothing if no URL in query', async () => {
    const ctx = createMockInlineQueryCtx({
      inlineQuery: { query: 'no url here' },
    });
    await inlineQueryHandler(ctx as any);
    expect(mockGetInfo).not.toHaveBeenCalled();
    expect(ctx.answerInlineQuery).not.toHaveBeenCalled();
  });

  it('handles errors gracefully and shows error to user', async () => {
    const ctx = createMockInlineQueryCtx();
    mockGetInfo.mockRejectedValue(new Error('fail!'));
    const mockError = spyOn(console, 'error').mockImplementationOnce(() => {});

    await inlineQueryHandler(ctx as any);
    // Should not throw, should show error to user
    expect(ctx.answerInlineQuery).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'article',
        title: 'Failed to process video',
        description: 'fail!',
      }),
    ]);
    expect(mockError).toHaveBeenCalledTimes(1);
  });

  it('shows a sensible message when the inline failure is not an Error', async () => {
    const ctx = createMockInlineQueryCtx();
    mockGetInfo.mockRejectedValueOnce('boom');
    spyOn(console, 'error').mockImplementationOnce(() => {});
    await inlineQueryHandler(ctx as any);
    expect(ctx.answerInlineQuery).toHaveBeenCalledWith([
      expect.objectContaining({
        description: 'An unknown error occurred',
        input_message_content: {
          message_text: 'Failed to process video: An unknown error occurred',
        },
      }),
    ]);
  });

  it('answers a shutdown-aborted inline query with a retry hint, not a resume promise', async () => {
    const ctx = createMockInlineQueryCtx();
    mockGetInfo.mockRejectedValueOnce(new jobQueue.ShutdownAbort());
    spyOn(console, 'error').mockImplementationOnce(() => {});
    await inlineQueryHandler(ctx as any);
    expect(ctx.answerInlineQuery).toHaveBeenCalledWith([
      expect.objectContaining({
        // inline work has no queue row; "resumes shortly" would be a lie
        description: 'The bot is restarting, please try again in a moment',
      }),
    ]);
  });

  it('rejects an oversize video up front, without downloading', async () => {
    const ctx = createMockInlineQueryCtx();
    mockGetInfo.mockResolvedValueOnce({
      webpage_url: 'https://example.com',
      title: 'Huge',
      filename: 'huge.mp4',
      filesize_approx: 3 * 1024 * 1024 * 1024, // 3 GB > the 2 GB send limit
    } as any);

    await inlineQueryHandler(ctx as any);

    expect(mockDownloadVideo).not.toHaveBeenCalled();
    expect(mockSendVideo).not.toHaveBeenCalled();
    expect(ctx.answerInlineQuery).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'article',
        title: 'Video too large',
        description: expect.stringContaining('3072.00 MB'),
        input_message_content: {
          message_text: 'Video too large to send (3072.00 MB).',
        },
      }),
    ]);
  });

  it('answers "too large" when the real bytes exceed the limit post-download', async () => {
    const ctx = createMockInlineQueryCtx();
    mockGetInfo.mockResolvedValueOnce({
      webpage_url: 'https://example.com',
      title: 'T',
      filename: 'v.mp4',
    } as any);
    mockSendVideo.mockResolvedValueOnce(undefined as any);

    await inlineQueryHandler(ctx as any);

    expect(mockDownloadVideo).toHaveBeenCalled();
    expect(ctx.answerInlineQuery).toHaveBeenCalledWith([
      expect.objectContaining({ type: 'article', title: 'Video too large' }),
    ]);
  });
});

describe('confirmation for long videos (>20 min)', () => {
  const LONG_DURATION = 25 * 60; // 25 minutes

  const mockGetInfoLong = () =>
    mockGetInfo.mockImplementation(
      memoize(
        mock(async (_log, url, _verbose) => ({
          webpage_url: url,
          title: 'Long Video',
          extractor: 'test',
          id: 'id',
          description: 'desc',
          filename: 'long-video.mp4',
          duration: LONG_DURATION,
        })),
      ),
    );

  const mockGetInfoShort = (duration: number = 5 * 60) =>
    mockGetInfo.mockImplementation(
      memoize(
        mock(async (_log: any, url: string) => ({
          webpage_url: url,
          title: 'Short Video',
          extractor: 'test',
          id: 'id',
          description: 'desc',
          filename: 'short-video.mp4',
          duration,
        })),
      ),
    );

  // Helper: trigger confirmation in a group chat and return the button callback data
  const triggerConfirmation = async () => {
    mockGetInfoLong();
    const msgCtx = createMockMessageCtx(false, { chat: groupChat });
    await handle(msgCtx as any);
    const buttons = (msgCtx.telegram.sendMessage as any).mock.calls[0][2]
      .reply_markup.inline_keyboard[0];
    return {
      msgCtx,
      confirmData: buttons[0].callback_data as string,
      cancelData: buttons[1].callback_data as string,
    };
  };

  it('does not orphan the pending row when the confirmation send fails', async () => {
    mockGetInfoLong();
    const ctx = createMockMessageCtx(false, { chat: groupChat });
    (ctx.telegram.sendMessage as any).mockRejectedValueOnce(new Error('429'));
    const mockError = spyMock(console, 'error');

    await handle(ctx as any); // the handler contains the send failure

    // the confirmation send was actually attempted (and is the only send, so
    // the rejection hit it): without this the no-orphan check passes vacuously
    expect(ctx.telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(rowCount('pending')).toBe(0); // the parked row was rolled back
    mockError.mockRestore();
  });

  describe.each([false, true])('textMessageHandler, edit: %p', (isEdit) => {
    it('shows confirmation buttons for video >20 min in group chat', async () => {
      mockGetInfoLong();
      const ctx = createMockMessageCtx(isEdit, { chat: groupChat });
      await handle(ctx as any);

      // Should NOT download
      expect(mockDownloadVideo).not.toHaveBeenCalled();
      expect(mockSendVideo).not.toHaveBeenCalled();

      // Should send a message with inline keyboard
      expect(ctx.telegram.sendMessage).toHaveBeenCalledTimes(1);
      const [chatId, text, opts] = (ctx.telegram.sendMessage as any).mock
        .calls[0];
      expect(chatId).toBe(-100);
      expect(text).toBe(
        'This video is pretty long (25m), do you want me to download it anyway?',
      );
      expect(opts.reply_parameters).toEqual({ message_id: 1 });
      expect(opts.reply_markup.inline_keyboard).toBeArray();
      const buttons = opts.reply_markup.inline_keyboard[0];
      expect(buttons).toHaveLength(2);
      expect(buttons[0].callback_data).toMatch(/^dl:/);
      expect(buttons[1].callback_data).toMatch(/^no:/);
    });

    it('formats duration with seconds in confirmation message', async () => {
      mockGetInfo.mockImplementation(
        memoize(
          mock(async (_log, url, _verbose) => ({
            webpage_url: url,
            title: 'Long Video',
            extractor: 'test',
            id: 'id',
            description: 'desc',
            filename: 'long-video.mp4',
            duration: 25 * 60 + 30, // 25m 30s
          })),
        ),
      );
      const ctx = createMockMessageCtx(isEdit, { chat: groupChat });
      await handle(ctx as any);

      const [, text] = (ctx.telegram.sendMessage as any).mock.calls[0];
      expect(text).toBe(
        'This video is pretty long (25m 30s), do you want me to download it anyway?',
      );
    });

    it('downloads immediately for video >20 min in private chat', async () => {
      mockGetInfoLong();
      const ctx = createMockMessageCtx(isEdit);
      await handle(ctx as any);

      // Private chats skip confirmation
      expect(mockDownloadVideo).toHaveBeenCalled();
      expect(mockSendVideo).toHaveBeenCalled();
    });

    it('downloads immediately for video <=20 min in group chat', async () => {
      mockGetInfoShort();
      const ctx = createMockMessageCtx(isEdit, { chat: groupChat });
      await handle(ctx as any);

      expect(mockDownloadVideo).toHaveBeenCalled();
      expect(mockSendVideo).toHaveBeenCalled();
    });

    // blobKey depends only on the identity fields, so this matches whatever
    // info object the mocked getInfo hands the handler for the same video
    const shortInfo = {
      extractor: 'test',
      id: 'id',
      filename: 'short-video.mp4',
      title: 'Short Video',
    } as any;

    it('checks the stored real duration after download in group chats even when metadata says short', async () => {
      // metadata claims 5 min, but the blob row (written by downloadVideo's
      // post-download probe: mocked here, so seed it) knows the real 25 min:
      // the post-download backstop must park a confirmation, not send
      mockGetInfoShort(5 * 60);
      blobStore.recordBlob(shortInfo);
      blobStore.setBlobDuration(shortInfo, 25 * 60);
      const ctx = createMockMessageCtx(isEdit, { chat: groupChat });
      await handle(ctx as any);

      expect(mockDownloadVideo).toHaveBeenCalled();
      expect(mockSendVideo).not.toHaveBeenCalled();
      const [, text] = (ctx.telegram.sendMessage as any).mock.calls[0];
      expect(text).toContain('pretty long (25m)');
    });

    it('sends when the stored real duration is short too', async () => {
      mockGetInfoShort(5 * 60);
      blobStore.recordBlob(shortInfo);
      blobStore.setBlobDuration(shortInfo, 5 * 60);
      const ctx = createMockMessageCtx(isEdit, { chat: groupChat });
      await handle(ctx as any);

      expect(mockDownloadVideo).toHaveBeenCalled();
      expect(mockSendVideo).toHaveBeenCalled();
    });

    it('gates on the stored duration BEFORE download when metadata lacks one (uploaded blob, bytes gone)', async () => {
      // a >20-min video with NO metadata duration was already uploaded once
      // (file_id cached, bytes disposed): nothing left to probe, so only the
      // stored duration can keep it from slipping past the group gate
      // (an explicit `undefined` would hit mockGetInfoShort's 5-min default)
      mockGetInfo.mockImplementation(
        memoize(
          mock(async (_log: any, url: string) => ({
            webpage_url: url,
            title: 'Short Video',
            extractor: 'test',
            id: 'id',
            description: 'desc',
            filename: 'short-video.mp4',
          })),
        ),
      );
      blobStore.recordBlob(shortInfo);
      blobStore.setBlobDuration(shortInfo, 25 * 60);
      blobStore.setBlobFileId(shortInfo, 'cached-file-id');
      const ctx = createMockMessageCtx(isEdit, { chat: groupChat });
      await handle(ctx as any);

      // parked for confirmation up front: no download, no send
      expect(mockDownloadVideo).not.toHaveBeenCalled();
      expect(mockSendVideo).not.toHaveBeenCalled();
      const [, text] = (ctx.telegram.sendMessage as any).mock.calls[0];
      expect(text).toContain('pretty long');
    });
  });

  describe('callbackQueryHandler', () => {
    it('confirms download when requester clicks Download', async () => {
      const { confirmData } = await triggerConfirmation();

      const cbCtx = createMockCallbackCtx(confirmData, 123);
      await handleCb(cbCtx as any);

      expect(cbCtx.answerCbQuery).toHaveBeenCalledWith('Starting download...');
      expect(cbCtx.deleteMessage).toHaveBeenCalled();
      expect(mockDownloadVideo).toHaveBeenCalled();
      expect(mockSendVideo).toHaveBeenCalled();
    });

    it('allows a different group member to confirm download', async () => {
      const { confirmData } = await triggerConfirmation();

      const cbCtx = createMockCallbackCtx(confirmData, 999);
      await handleCb(cbCtx as any);

      expect(cbCtx.answerCbQuery).toHaveBeenCalledWith('Starting download...');
      expect(mockDownloadVideo).toHaveBeenCalled();
      expect(mockSendVideo).toHaveBeenCalled();
    });

    it('cancels download when requester clicks Cancel', async () => {
      const { cancelData } = await triggerConfirmation();

      const cbCtx = createMockCallbackCtx(cancelData, 123);
      await handleCb(cbCtx as any);

      expect(cbCtx.answerCbQuery).toHaveBeenCalledWith('Cancelled.');
      expect(cbCtx.deleteMessage).toHaveBeenCalled();
      expect(mockDownloadVideo).not.toHaveBeenCalled();
      expect(mockSendVideo).not.toHaveBeenCalled();
    });

    it('rejects cancel from non-requester without removing the pending row', async () => {
      const { cancelData } = await triggerConfirmation();
      const takeSpy = spyOn(pendingDownloads, 'takePending');

      const cbCtx = createMockCallbackCtx(cancelData, 999);
      await handleCb(cbCtx as any);

      expect(cbCtx.answerCbQuery).toHaveBeenCalledWith(
        'Only the requester can cancel.',
      );
      expect(mockDownloadVideo).not.toHaveBeenCalled();
      expect(takeSpy).not.toHaveBeenCalled();
      takeSpy.mockRestore();
    });

    it('treats an authorized cancel as unavailable if a confirm adopted it first', async () => {
      const { cancelData } = await triggerConfirmation();
      spyOn(pendingDownloads, 'takePending').mockResolvedValueOnce(undefined);

      const cbCtx = createMockCallbackCtx(cancelData, 123);
      await handleCb(cbCtx as any);

      expect(cbCtx.answerCbQuery).toHaveBeenCalledWith(
        'This request is no longer available.',
      );
    });

    it('answers gracefully when handling throws unexpectedly', async () => {
      const mockError = spyMock(console, 'error');
      mockAdopt.mockImplementationOnce(() => {
        throw new Error('disk on fire');
      });
      await triggerConfirmation();
      const cbCtx = createMockCallbackCtx('dl:aaaa', 123);
      await handleCb(cbCtx as any); // must not throw
      expect(mockError).toHaveBeenCalledWith(
        'Error handling callback query:',
        expect.any(Error),
      );
      expect(cbCtx.answerCbQuery).toHaveBeenCalledWith('Something went wrong.');
    });

    it('answers silently for malformed callback data', async () => {
      const cbCtx = createMockCallbackCtx('garbage', 123);
      await handleCb(cbCtx as any);
      expect(cbCtx.answerCbQuery).toHaveBeenCalledWith('');
      expect(mockDownloadVideo).not.toHaveBeenCalled();
    });

    it('survives answerCbQuery failures', async () => {
      const mockError = spyMock(console, 'error');
      const cbCtx = createMockCallbackCtx('garbage', 123);
      (cbCtx.answerCbQuery as any).mockImplementationOnce(() =>
        Promise.reject(new Error('query is too old')),
      );
      await handleCb(cbCtx as any);
      expect(mockError).toHaveBeenCalledWith(
        'answerCbQuery failed:',
        expect.any(Error),
      );
    });

    it('responds with unavailable for unknown callback data', async () => {
      const cbCtx = createMockCallbackCtx('dl:nonexistent', 123);
      await handleCb(cbCtx as any);

      expect(cbCtx.answerCbQuery).toHaveBeenCalledWith(
        'This request is no longer available.',
      );
      expect(mockDownloadVideo).not.toHaveBeenCalled();
    });

    it('leaves the claim clickable when the move into the queue fails', async () => {
      const consoleError = spyMock(console, 'error');
      const { confirmData } = await triggerConfirmation();
      // a non-ENOENT failure (a disk error): the pending row is untouched, so
      // the claim stays clickable for a retry
      mockAdopt.mockImplementationOnce(() =>
        Promise.reject(new Error('disk I/O error')),
      );
      const cbCtx = createMockCallbackCtx(confirmData);
      await handleCb(cbCtx as any);
      expect(cbCtx.answerCbQuery).toHaveBeenCalledWith('Something went wrong.');
      expect(consoleError).toHaveBeenCalled();
      // the claim survived: clicking again works
      const cbCtx2 = createMockCallbackCtx(confirmData);
      await handleCb(cbCtx2 as any);
      expect(mockDownloadVideo).toHaveBeenCalled();
      expect(mockSendVideo).toHaveBeenCalled();
    });

    it('responds with unavailable on duplicate confirm', async () => {
      const { confirmData } = await triggerConfirmation();

      // First click succeeds
      const cbCtx1 = createMockCallbackCtx(confirmData, 123);
      await callbackQueryHandler(cbCtx1 as any);
      expect(cbCtx1.answerCbQuery).toHaveBeenCalledWith('Starting download...');

      // Second click: pending was already taken
      const cbCtx2 = createMockCallbackCtx(confirmData, 123);
      await callbackQueryHandler(cbCtx2 as any);
      expect(cbCtx2.answerCbQuery).toHaveBeenCalledWith(
        'This request is no longer available.',
      );
    });

    it('handles download errors gracefully on confirm (group retry stays silent)', async () => {
      const { confirmData } = await triggerConfirmation();
      // Reject lazily: mockRejectedValueOnce creates the rejected promise
      // eagerly, and the handler crosses an event loop tick (file I/O in
      // takePending) before awaiting it, so Bun reports it as an unhandled
      // rejection and fails the test.
      mockDownloadVideo.mockImplementationOnce(() =>
        Promise.reject(new Error('network fail')),
      );
      const mockError = spyMock(console, 'error');

      const cbCtx = createMockCallbackCtx(confirmData, 123);
      await handleCb(cbCtx as any);

      expect(cbCtx.answerCbQuery).toHaveBeenCalledWith('Starting download...');
      expect(mockError).toHaveBeenCalled();
      // a group retry stays silent, only the terminal report would post
      // (reportJobFailure; the retry is attempt 1 of 3 here)
      expect(mockLog.append).not.toHaveBeenCalled();
    });

    it('responds with unavailable on duplicate cancel', async () => {
      const { cancelData } = await triggerConfirmation();

      // First click cancels
      const cbCtx1 = createMockCallbackCtx(cancelData, 123);
      await callbackQueryHandler(cbCtx1 as any);
      expect(cbCtx1.answerCbQuery).toHaveBeenCalledWith('Cancelled.');

      // Second click: pending was already taken
      const cbCtx2 = createMockCallbackCtx(cancelData, 123);
      await callbackQueryHandler(cbCtx2 as any);
      expect(cbCtx2.answerCbQuery).toHaveBeenCalledWith(
        'This request is no longer available.',
      );
    });
  });
});

describe('post-download duration check', () => {
  const LONG_DURATION = 25 * 60;

  // the real downloadVideo records the blob and stores the probed duration on
  // its row (the handler reads getBlob().duration rather than probing):
  // emulate that contract here, still driven through mockProbeDuration
  beforeEach(() => {
    mockDownloadVideo.mockImplementation(async (_log: any, info: any) => {
      blobStore.recordBlob(info);
      const d = await downloadVideo.probeDuration(info.filename);
      if (d) blobStore.setBlobDuration(info, d);
      return 'downloaded';
    });
  });
  afterAll(() => {
    mockDownloadVideo.mockResolvedValue('downloaded');
  });

  const mockGetInfoNoDuration = () =>
    mockGetInfo.mockImplementation(
      memoize(
        mock(async (_log: any, url: string) => ({
          webpage_url: url,
          title: 'Unknown Duration Video',
          extractor: 'test',
          id: 'id',
          description: 'desc',
          filename: 'unknown-duration.mp4',
        })),
      ),
    );

  const mockGetInfoZeroDuration = () =>
    mockGetInfo.mockImplementation(
      memoize(
        mock(async (_log: any, url: string) => ({
          webpage_url: url,
          title: 'Zero Duration Video',
          extractor: 'test',
          id: 'id',
          description: 'desc',
          filename: 'zero-duration.mp4',
          duration: 0,
        })),
      ),
    );

  it('releases the blob (and pending) when a postDownload confirmation send fails', async () => {
    mockGetInfoNoDuration();
    mockProbeDuration.mockResolvedValueOnce(LONG_DURATION);
    const ctx = createMockMessageCtx(false, { chat: groupChat });
    (ctx.telegram.sendMessage as any).mockRejectedValueOnce(new Error('429'));
    const mockError = spyMock(console, 'error');

    await handle(ctx as any);

    expect(ctx.telegram.sendMessage).toHaveBeenCalledTimes(1); // the confirmation
    expect(mockReleaseBlob).toHaveBeenCalledWith(
      expect.objectContaining({ filename: 'unknown-duration.mp4' }),
    );
    expect(rowCount('pending')).toBe(0); // no pending orphan
    mockError.mockRestore();
  });

  describe.each([false, true])('textMessageHandler, edit: %p', (isEdit) => {
    it('downloads then shows confirmation when duration unknown and ffprobe finds >20min', async () => {
      mockGetInfoNoDuration();
      mockProbeDuration.mockResolvedValueOnce(LONG_DURATION);
      const ctx = createMockMessageCtx(isEdit, { chat: groupChat });
      await handle(ctx as any);

      // Should download (duration unknown = proceed)
      expect(mockDownloadVideo).toHaveBeenCalled();
      // Should NOT upload yet (ffprobe found it's long)
      expect(mockSendVideo).not.toHaveBeenCalled();
      // Should show same confirmation dialog as pre-download check
      expect(ctx.telegram.sendMessage).toHaveBeenCalledTimes(1);
      const [, text, opts] = (ctx.telegram.sendMessage as any).mock.calls[0];
      expect(text).toBe(
        'This video is pretty long (25m), do you want me to download it anyway?',
      );
      expect(opts.reply_parameters).toEqual({ message_id: 1 });
      expect(opts.reply_markup.inline_keyboard[0]).toHaveLength(2);
    });

    it('downloads then shows confirmation when duration is 0 and ffprobe finds >20min', async () => {
      mockGetInfoZeroDuration();
      mockProbeDuration.mockResolvedValueOnce(LONG_DURATION);
      const ctx = createMockMessageCtx(isEdit, { chat: groupChat });
      await handle(ctx as any);

      expect(mockDownloadVideo).toHaveBeenCalled();
      expect(mockSendVideo).not.toHaveBeenCalled();
      expect(ctx.telegram.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('downloads and uploads immediately when duration unknown and ffprobe finds <=20min', async () => {
      mockGetInfoNoDuration();
      mockProbeDuration.mockResolvedValueOnce(5 * 60); // 5 minutes
      const ctx = createMockMessageCtx(isEdit, { chat: groupChat });
      await handle(ctx as any);

      expect(mockDownloadVideo).toHaveBeenCalled();
      expect(mockSendVideo).toHaveBeenCalled();
    });

    it('re-probes and stores when a crash left the blob row without a duration', async () => {
      // the download's own probe fails (a crash window leaves the same shape:
      // row recorded, duration never stored); the gate must re-probe rather
      // than let a duration-less long video skip confirmation forever
      mockGetInfoNoDuration();
      mockProbeDuration
        .mockResolvedValueOnce(undefined) // during the (emulated) download
        .mockResolvedValueOnce(LONG_DURATION); // the gate's backfill
      const ctx = createMockMessageCtx(isEdit, { chat: groupChat });
      await handle(ctx as any);

      expect(mockSendVideo).not.toHaveBeenCalled();
      expect(ctx.telegram.sendMessage).toHaveBeenCalledTimes(1); // confirmation
      // and the backfilled duration is stored for the next request (the same
      // identity the mocked info carries, so the keys match)
      expect(
        blobStore.getBlob({ extractor: 'test', id: 'id' } as any)?.duration,
      ).toBe(LONG_DURATION);
    });

    it('downloads and uploads immediately when duration unknown and ffprobe fails', async () => {
      mockGetInfoNoDuration();
      mockProbeDuration.mockResolvedValueOnce(undefined);
      const ctx = createMockMessageCtx(isEdit, { chat: groupChat });
      await handle(ctx as any);

      expect(mockDownloadVideo).toHaveBeenCalled();
      expect(mockSendVideo).toHaveBeenCalled();
    });

    it('private chat with unknown duration downloads and uploads without any confirmation', async () => {
      mockGetInfoNoDuration();
      const ctx = createMockMessageCtx(isEdit); // private chat
      await handle(ctx as any);

      expect(mockDownloadVideo).toHaveBeenCalled();
      expect(mockSendVideo).toHaveBeenCalled();
      // the download itself probes in every chat type (the stored duration
      // serves future group requests); what private chats skip is the gate
      expect(ctx.telegram.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('callbackQueryHandler (post-download)', () => {
    // Helper: trigger post-download confirmation
    const triggerPostDownloadConfirmation = async () => {
      mockGetInfoNoDuration();
      mockProbeDuration.mockResolvedValueOnce(LONG_DURATION);
      const msgCtx = createMockMessageCtx(false, { chat: groupChat });
      await handle(msgCtx as any);
      const buttons = (msgCtx.telegram.sendMessage as any).mock.calls[0][2]
        .reply_markup.inline_keyboard[0];
      return {
        msgCtx,
        confirmData: buttons[0].callback_data as string,
        cancelData: buttons[1].callback_data as string,
      };
    };

    it('uploads on confirm (the download call is a no-op when the blob is present)', async () => {
      const { confirmData } = await triggerPostDownloadConfirmation();
      jest.clearAllMocks(); // clear download mock calls from setup

      const cbCtx = createMockCallbackCtx(confirmData, 123);
      await handleCb(cbCtx as any);

      expect(cbCtx.answerCbQuery).toHaveBeenCalledWith('Starting download...');
      // downloadVideo is called but short-circuits in reality (isDownloaded);
      // the upload is what matters here
      expect(mockSendVideo).toHaveBeenCalled();
    });

    it('releases the blob, and does not upload, on cancel', async () => {
      const { cancelData } = await triggerPostDownloadConfirmation();
      jest.clearAllMocks();

      const cbCtx = createMockCallbackCtx(cancelData, 123);
      await handleCb(cbCtx as any);

      expect(cbCtx.answerCbQuery).toHaveBeenCalledWith('Cancelled.');
      expect(mockDownloadVideo).not.toHaveBeenCalled();
      expect(mockSendVideo).not.toHaveBeenCalled();
      expect(mockReleaseBlob).toHaveBeenCalledWith(
        expect.objectContaining({ filename: 'unknown-duration.mp4' }),
      );
    });
  });
});

// a parked-confirmation job as adoptJob delivers it; override what varies
const confirmedJob = (overrides: Record<string, unknown> = {}) =>
  ({
    kind: 'confirmed',
    info: { filename: 'v.mp4', title: 'T', webpage_url: 'u' },
    verbose: false,
    messageId: 7,
    chatId: 7,
    chatType: 'private',
    postDownload: false,
    ...overrides,
  }) as any;

describe('confirmed job stale-info refresh', () => {
  it('re-resolves through getInfo when no blob exists yet', async () => {
    // the payload pins a snapshot whose signed URLs expire; with nothing
    // downloaded to reuse, the job must go through getInfo (fresh within its
    // TTL = DB hit, stale = live re-scrape)
    const job = confirmedJob({
      info: {
        filename: 'v.mp4',
        title: 'Old Snapshot',
        webpage_url: 'https://example.com',
      },
    });
    await processJob({} as any, job, 1);
    expect(mockGetInfo).toHaveBeenCalledWith(
      expect.anything(),
      'https://example.com',
      false,
    );
    expect(mockSendVideo).toHaveBeenCalled();
  });

  it('reuses an existing blob without re-resolving', async () => {
    const info = {
      filename: 'v.mp4',
      title: 'T',
      webpage_url: 'https://example.com',
      extractor: 'test',
      id: 'has-blob',
    } as any;
    blobStore.recordBlob(info);
    blobStore.setBlobFileId(info, 'cached');
    const job = confirmedJob({ info, postDownload: true });
    await processJob({} as any, job, 1);
    expect(mockGetInfo).not.toHaveBeenCalled(); // the blob answers already
    expect(mockSendVideo).toHaveBeenCalled();
  });
});

describe('confirmed job oversize report', () => {
  it('reports too-large (not silently) when real bytes overshoot the estimate', async () => {
    // the real bytes overshoot a missing/under estimate, so sendVideo returns
    // undefined; verify the report routes around the silent progress NoLog
    mockSendVideo.mockResolvedValueOnce(undefined as any);
    const job = confirmedJob({ chatId: -100 });

    await expect(processJob({} as any, job, 1)).resolves.toBeUndefined();

    expect(mockDownloadVideo).toHaveBeenCalled();
    expect(mockLog.append).toHaveBeenCalledWith(
      expect.stringContaining('Video too large'),
    );
    // sendVideo already discarded the drifted info's oversize bytes; the only
    // release is the drift guard freeing the parked (pre-refresh) job.info
    // identity, whose key the getInfo refresh drifted away from. It has no
    // recorded blob here, so the release is a harmless no-op, but never the
    // drifted `info` sendVideo already handled (no double-release of that).
    for (const [released] of mockReleaseBlob.mock.calls) {
      expect((released as any).webpage_url).toBe(job.info.webpage_url);
    }
  });
});

describe('job retry classification', () => {
  const urlJob = {
    kind: 'url',
    url: 'https://example.com',
    chatId: 1,
    chatType: 'private',
    messageId: 2,
    fromId: 3,
    verbose: false,
  };
  const lastAppend = () => mockLog.append.mock.calls.map(([s]) => s).at(-1);
  beforeEach(() => spyMock(console, 'error'));

  it('a shutdown abort rethrows silently, stashing the log pointer for the re-run', async () => {
    mockGetInfo.mockRejectedValueOnce(new jobQueue.ShutdownAbort());
    const job = { ...urlJob };
    await expect(processJob({} as any, job as any, 1)).rejects.toThrow(
      'restarting',
    );
    expect(mockLog.append).not.toHaveBeenCalled(); // no user-facing report
    expect(mockReleaseBlob).not.toHaveBeenCalled(); // nothing released
    // flushed BEFORE the stash: a debounced first send that hasn't fired yet
    // would otherwise post during the drain and fork a duplicate thread
    expect(mockLog.flush).toHaveBeenCalled();
    expect(job.logMessageId).toBe(4242); // the re-run continues this thread
    expect((job as any).logText).toBe('prior log content');
  });

  it('re-prints the info block only when the delivered thread lacks it', async () => {
    // died during the scrape: infoShown never set → info must print, and the
    // flag is set for persistence (the retry bump re-serializes the job)
    const j1 = { ...urlJob, logText: '🧐 <b>Scraping</b> x...' };
    await processJob({} as any, j1 as any, 2);
    expect(mockSendInfo).toHaveBeenCalledTimes(1);
    expect((j1 as any).infoShown).toBe(true);

    jest.clearAllMocks();
    // shown AND delivered (a thread exists): skip, even though the info text
    // may sit in an earlier chunk than the stashed last one
    const j2 = { ...urlJob, logMessageId: 4242, logText: 'x', infoShown: true };
    await processJob({} as any, j2 as any, 2);
    expect(mockSendInfo).not.toHaveBeenCalled();

    jest.clearAllMocks();
    // appended but NEVER delivered (every send failed, so no thread was
    // stashed): the retry posts a fresh thread, which needs the info again
    const j3 = { ...urlJob, logMessageId: undefined, infoShown: true };
    await processJob({} as any, j3 as any, 2);
    expect(mockSendInfo).toHaveBeenCalledTimes(1);

  });

  it('rethrows a retryable error, reports ⚠️, and saves the message id for the retry', async () => {
    mockGetInfo.mockRejectedValueOnce(new Error('network blip'));
    const job = { ...urlJob };
    await expect(processJob({} as any, job as any, 1)).rejects.toThrow(
      'network blip',
    );
    expect(lastAppend()).toBe(
      '\n⚠️ <b>Download failed</b>, retrying (attempt 2 of 3)...\n',
    );
    expect(job.logMessageId).toBe(4242);
    // the content rides along, so the retry continues (not wipes) the message
    expect(job.logText).toBe('prior log content');
  });

  it('does not retry a permanent (unsupported-URL) error, reporting 💥', async () => {
    mockGetInfo.mockRejectedValueOnce(
      new downloadVideo.YtdlpError(
        'yt-dlp exited with code 1',
        'ERROR: Unsupported URL: https://example.com',
      ),
    );
    await expect(
      processJob({} as any, urlJob as any, 1),
    ).resolves.toBeUndefined();
    // the user sees yt-dlp's own ERROR line, not the useless exit code
    expect(lastAppend()).toBe(
      '\n💥 <b>Download failed</b>: Unsupported URL: https://example.com',
    );
  });

  it('does not retry a permanent Telegram error (bot blocked), reporting 💥', async () => {
    // classification is what's under test, so any step throwing the 403 will do
    mockGetInfo.mockRejectedValueOnce(
      telegramError(403, 'Forbidden: bot was blocked by the user'),
    );
    await expect(
      processJob({} as any, urlJob as any, 1),
    ).resolves.toBeUndefined(); // no rethrow => no retry
    expect(lastAppend()).toBe(
      '\n💥 <b>Download failed</b>: Forbidden: bot was blocked by the user',
    );
  });

  it('stops retrying on the final attempt, reporting 💥', async () => {
    mockGetInfo.mockRejectedValueOnce(new Error('still down'));
    await expect(
      processJob({} as any, urlJob as any, 3),
    ).resolves.toBeUndefined();
    expect(lastAppend()).toBe('\n💥 <b>Download failed</b>: still down');
  });

  it('reports a private confirmed-job retry (reasonless) and saves the message id', async () => {
    mockDownloadVideo.mockRejectedValueOnce(new Error('network fail'));
    const job = confirmedJob();
    // edit/resend/not-modified behavior is covered in log-message.test.ts
    await expect(processJob({} as any, job, 1)).rejects.toThrow('network fail');
    expect(lastAppend()).toBe(
      '⚠️ <b>Download failed</b>, retrying (attempt 2 of 3)...\n',
    );
    expect(job.logMessageId).toBe(4242);
  });

  it('says nothing in a group when the reply target was deleted', async () => {
    mockDownloadVideo.mockRejectedValueOnce(
      telegramError(400, 'Bad Request: message to be replied not found'),
    );
    const job = confirmedJob({ chatId: -100, chatType: 'group' });
    // permanent, so it resolves (no retry) with no report at all
    await expect(processJob({} as any, job, 1)).resolves.toBeUndefined();
    expect(mockLog.append).not.toHaveBeenCalled();
  });

  it('un-records the originating URL when a confirmed job fails terminally', async () => {
    // the payload carries the url the record used (info.webpage_url may be a
    // different alias), so the edit-retry gesture re-opens like a url job's
    db.query(
      'INSERT INTO handled_urls (chat_id, message_id, url, created_at) VALUES (?, ?, ?, ?)',
    ).run(7, 7, 'https://typed.example', Date.now());
    mockDownloadVideo.mockRejectedValueOnce(
      new downloadVideo.YtdlpError(
        'failed',
        'ERROR: Unsupported URL: https://x',
      ),
    );
    const job = confirmedJob({ url: 'https://typed.example' });
    await expect(processJob({} as any, job, 1)).resolves.toBeUndefined();
    expect(rowCount('handled_urls')).toBe(0);
  });

  it('releases the parked blob even when getInfo re-resolve drifts the format', async () => {
    // the top-of-body getInfo re-resolve can pick a different format_id, so the
    // re-resolved info's blob key differs from the parked job.info's. A
    // terminal failure must release BOTH, or the parked identity's
    // pre-downloaded blob is stranded until the 24h TTL sweep.
    const parkedInfo = {
      filename: 'v.mp4',
      title: 'T',
      webpage_url: 'https://drift.example',
      extractor: 'test',
      id: 'vid',
      format_id: 'orig',
    } as any;
    // seed a blob under the PARKED identity (no file_id, so isDownloaded is
    // false and the re-resolve fires)
    blobStore.recordBlob(parkedInfo);
    expect(blobStore.getBlob(parkedInfo)).not.toBeNull();
    // re-resolve returns a DIFFERENT format_id => a different blob key
    mockGetInfo.mockImplementationOnce(async (_log, url) => ({
      filename: 'v.mp4',
      title: 'T',
      webpage_url: url,
      extractor: 'test',
      id: 'vid',
      format_id: 'drifted',
    }));
    mockDownloadVideo.mockRejectedValueOnce(
      new downloadVideo.YtdlpError(
        'failed',
        'ERROR: Unsupported URL: https://drift.example',
      ),
    );
    const job = confirmedJob({ info: parkedInfo });
    await expect(processJob({} as any, job, 1)).resolves.toBeUndefined();
    // the original parked blob row is released, not stranded
    expect(blobStore.getBlob(parkedInfo)).toBeNull();
  });

  it('releases the parked blob when a drifted send returns too-large', async () => {
    // same drift, but the download succeeds and sendVideo returns undefined
    // (real bytes too large). sendVideo released the drifted info's blob; the
    // parked job.info's fileless blob would strand without the drift release.
    const parkedInfo = {
      filename: 'v.mp4',
      title: 'T',
      webpage_url: 'https://drift.example',
      extractor: 'test',
      id: 'vid',
      format_id: 'orig',
    } as any;
    blobStore.recordBlob(parkedInfo);
    expect(blobStore.getBlob(parkedInfo)).not.toBeNull();
    // re-resolve returns a DIFFERENT format_id => a different blob key
    mockGetInfo.mockImplementationOnce(async (_log, url) => ({
      filename: 'v.mp4',
      title: 'T',
      webpage_url: url,
      extractor: 'test',
      id: 'vid',
      format_id: 'drifted',
    }));
    mockSendVideo.mockResolvedValueOnce(undefined as any);
    const job = confirmedJob({ info: parkedInfo });
    await expect(processJob({} as any, job, 1)).resolves.toBeUndefined();
    // the original parked blob row is released, not stranded
    expect(blobStore.getBlob(parkedInfo)).toBeNull();
  });

  it('releases the parked blob on a fully successful drifted send', async () => {
    // same drift, but download and send both SUCCEED. The parked identity's
    // fileless row must still be freed on the happy path, not only on
    // failure/too-large.
    const parkedInfo = {
      filename: 'v.mp4',
      title: 'T',
      webpage_url: 'https://drift.example',
      extractor: 'test',
      id: 'vid',
      format_id: 'orig',
    } as any;
    blobStore.recordBlob(parkedInfo);
    expect(blobStore.getBlob(parkedInfo)).not.toBeNull();
    // re-resolve returns a DIFFERENT format_id => a different blob key
    mockGetInfo.mockImplementationOnce(async (_log, url) => ({
      filename: 'v.mp4',
      title: 'T',
      webpage_url: url,
      extractor: 'test',
      id: 'vid',
      format_id: 'drifted',
    }));
    const job = confirmedJob({ info: parkedInfo });
    await expect(processJob({} as any, job, 1)).resolves.toBeUndefined();
    expect(mockSendVideo).toHaveBeenCalled(); // the send succeeded
    // the parked blob row is released even though nothing failed
    expect(blobStore.getBlob(parkedInfo)).toBeNull();
  });

  it('keeps group retries silent; only the terminal report posts', async () => {
    mockDownloadVideo.mockRejectedValue(new Error('network fail'));
    const job = confirmedJob({ chatId: -100, chatType: 'group' });
    await expect(processJob({} as any, job, 1)).rejects.toThrow('network fail');
    expect(mockLog.append).not.toHaveBeenCalled(); // no retry play-by-play
    await expect(processJob({} as any, job, 3)).resolves.toBeUndefined();
    expect(lastAppend()).toBe(
      '💥 <b>Download failed</b>: network fail', // the terminal line still lands
    );
    mockDownloadVideo.mockResolvedValue('downloaded');
  });
});
