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
import * as downloadVideo from '../src/download-video.ts';
import {
  callbackQueryHandler,
  inlineQueryHandler,
  processJob,
  textMessageHandler,
} from '../src/handlers';
import * as jobQueue from '../src/job-queue';
import * as logMessage from '../src/log-message.ts';
import * as pendingDownloads from '../src/pending-downloads.ts';
import { memoize } from '../src/utils.ts';
import {
  createMockCallbackCtx,
  createMockMessageCtx,
  spyMock,
} from './test-utils.ts';

beforeEach(async () => {
  jest.clearAllMocks();
  // Must await: a fire-and-forget cleanup races with the test body and can
  // consume queued mockImplementationOnce's on the shared unlink spy.
  await pendingDownloads.clearPending();
});
afterAll(() => mock.restore());
spyMock(console, 'debug'); // suppress debug logs
const mockUnlink = spyOn(fsPromises, 'unlink').mockResolvedValue(undefined);

const mockLog = { append: mock(), flush: mock() };
spyOn(logMessage, 'LogMessage').mockReturnValue(mockLog as never);

// run enqueued jobs inline against the invoking ctx's telegram client, so
// the handler tests below exercise the full enqueue→process flow
let bridgeTg: any;
const mockEnqueue = spyOn(jobQueue, 'enqueueJob').mockImplementation(
  async (j) => {
    await processJob(bridgeTg, 'bot', j);
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

describe.each([false, true])('textMessageHandler, edit: %p', (isEdit) => {
  it('enqueues one durable job per URL with the message fields', async () => {
    const ctx = createMockMessageCtx(isEdit);
    await handle(ctx as any);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockEnqueue).toHaveBeenCalledWith({
      kind: 'url',
      url: 'https://example.com',
      chatId: 123,
      chatType: 'private',
      messageId: 1,
      fromId: 123,
      verbose: false,
    });
  });

  it('reports enqueue failures to the user', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(mock());
    mockEnqueue.mockImplementationOnce(() =>
      Promise.reject(new Error('disk full')),
    );
    const ctx = createMockMessageCtx(isEdit);
    await handle(ctx as any); // must not throw
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to enqueue download:',
      expect.any(Error),
    );
    expect(ctx.telegram.sendMessage).toHaveBeenCalledWith(
      123,
      expect.stringContaining('Download failed'),
      expect.objectContaining({ reply_parameters: { message_id: 1 } }),
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
    // Should append error to log and flush, but not throw
    expect(mockGetInfo).toHaveBeenCalled();
    expect(mockError).toHaveBeenCalledTimes(1);
    expect(mockLog.append).toHaveBeenCalledWith(
      '\n💥 <b>Download failed</b>: oh noes!',
    );
  });

  it('still logs the original error when reporting to the user fails', async () => {
    const ctx = createMockMessageCtx(isEdit);
    mockGetInfo.mockImplementationOnce(() =>
      Promise.reject(new Error('oh noes!')),
    );
    const mockError = spyOn(console, 'error').mockImplementation(() => {});
    mockLog.flush.mockImplementationOnce(() =>
      Promise.reject(new Error('telegram down')),
    );
    await handle(ctx as any); // must not throw
    const logged = mockError.mock.calls.map(([first]) => first);
    expect(logged).toContainEqual(expect.objectContaining({ message: 'oh noes!' }));
  });

  it('reports non-Error throws sensibly', async () => {
    const ctx = createMockMessageCtx(isEdit);
    mockGetInfo.mockImplementationOnce(() => Promise.reject('string error'));
    spyOn(console, 'error').mockImplementation(() => {});
    await handle(ctx as any);
    expect(mockLog.append).toHaveBeenCalledWith(
      '\n💥 <b>Download failed</b>: string error',
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

describe('inlineQueryHandler', () => {
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
});

describe('confirmation for long videos (>20 min)', () => {
  const LONG_DURATION = 25 * 60; // 25 minutes
  const groupChat = { id: -100, type: 'group', title: 'Test Group' };

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
      expect(text).toBe('This video is pretty long (25m), do you want me to download it anyway?');
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
      expect(text).toBe('This video is pretty long (25m 30s), do you want me to download it anyway?');
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

    it('probes duration after download in group chats even when duration is known', async () => {
      mockGetInfoShort(5 * 60); // 5 min known duration
      mockProbeDuration.mockResolvedValueOnce(5 * 60);
      const ctx = createMockMessageCtx(isEdit, { chat: groupChat });
      await handle(ctx as any);

      // Should download and probe
      expect(mockDownloadVideo).toHaveBeenCalled();
      expect(mockProbeDuration).toHaveBeenCalled();
      // Duration is short, so should still upload
      expect(mockSendVideo).toHaveBeenCalled();
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

      // User 999 (not the requester 123) clicks Download — should work
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

    it('rejects cancel from non-requester', async () => {
      const { cancelData } = await triggerConfirmation();

      // User 999 tries to cancel — only requester (123) should be allowed
      const cbCtx = createMockCallbackCtx(cancelData, 999);
      await handleCb(cbCtx as any);

      expect(cbCtx.answerCbQuery).toHaveBeenCalledWith(
        "Only the requester can cancel.",
      );
      expect(mockDownloadVideo).not.toHaveBeenCalled();
    });

    it('answers gracefully when handling throws unexpectedly', async () => {
      const mockError = spyOn(console, 'error').mockImplementation(() => {});
      spyOn(pendingDownloads, 'takePending').mockImplementationOnce(() => {
        throw new Error('disk on fire');
      });
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
      const mockError = spyOn(console, 'error').mockImplementation(() => {});
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

    it('restores the pending entry when enqueueing the confirm fails', async () => {
      const consoleError = spyOn(console, 'error').mockImplementation(mock());
      const { confirmData } = await triggerConfirmation();
      mockEnqueue.mockImplementationOnce(() =>
        Promise.reject(new Error('disk full')),
      );
      const cbCtx = createMockCallbackCtx(confirmData);
      await handleCb(cbCtx as any);
      expect(cbCtx.answerCbQuery).toHaveBeenCalledWith('Something went wrong.');
      expect(consoleError).toHaveBeenCalled();
      // the claim was restored: clicking again works
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

      // Second click — pending was already taken
      const cbCtx2 = createMockCallbackCtx(confirmData, 123);
      await callbackQueryHandler(cbCtx2 as any);
      expect(cbCtx2.answerCbQuery).toHaveBeenCalledWith('This request is no longer available.');
    });

    it('handles download errors gracefully on confirm and notifies user', async () => {
      const { confirmData } = await triggerConfirmation();
      // Reject lazily: mockRejectedValueOnce creates the rejected promise
      // eagerly, and the handler crosses an event loop tick (file I/O in
      // takePending) before awaiting it, so Bun reports it as an unhandled
      // rejection and fails the test.
      mockDownloadVideo.mockImplementationOnce(() =>
        Promise.reject(new Error('network fail')),
      );
      const mockError = spyOn(console, 'error').mockImplementation(() => {});

      const cbCtx = createMockCallbackCtx(confirmData, 123);
      await handleCb(cbCtx as any);

      expect(cbCtx.answerCbQuery).toHaveBeenCalledWith('Starting download...');
      expect(mockError).toHaveBeenCalled();
      // Should send error message to the chat
      expect(cbCtx.telegram.sendMessage).toHaveBeenCalledWith(
        -100, // chatId from the pending download
        expect.stringContaining('network fail'),
        expect.objectContaining({
          reply_parameters: { message_id: 1 },
          parse_mode: 'HTML',
        }),
      );
    });

    it('responds with unavailable on duplicate cancel', async () => {
      const { cancelData } = await triggerConfirmation();

      // First click cancels
      const cbCtx1 = createMockCallbackCtx(cancelData, 123);
      await callbackQueryHandler(cbCtx1 as any);
      expect(cbCtx1.answerCbQuery).toHaveBeenCalledWith('Cancelled.');

      // Second click — pending was already taken
      const cbCtx2 = createMockCallbackCtx(cancelData, 123);
      await callbackQueryHandler(cbCtx2 as any);
      expect(cbCtx2.answerCbQuery).toHaveBeenCalledWith('This request is no longer available.');
    });
  });
});

describe('post-download duration check', () => {
  const LONG_DURATION = 25 * 60;
  const groupChat = { id: -100, type: 'group', title: 'Test Group' };

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
      expect(text).toBe('This video is pretty long (25m), do you want me to download it anyway?');
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
      // No probeDuration check in private chats
      expect(mockProbeDuration).not.toHaveBeenCalled();
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

    it('uploads video without re-downloading on confirm', async () => {
      const { confirmData } = await triggerPostDownloadConfirmation();
      jest.clearAllMocks(); // clear download mock calls from setup

      const cbCtx = createMockCallbackCtx(confirmData, 123);
      await handleCb(cbCtx as any);

      expect(cbCtx.answerCbQuery).toHaveBeenCalledWith('Starting download...');
      // Should NOT re-download
      expect(mockDownloadVideo).not.toHaveBeenCalled();
      // Should upload
      expect(mockSendVideo).toHaveBeenCalled();
    });

    it('logs unexpected cleanup failures on cancel', async () => {
      const { cancelData } = await triggerPostDownloadConfirmation();
      const mockError = spyOn(console, 'error').mockImplementation(() => {});
      mockUnlink.mockImplementationOnce(() =>
        Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' })),
      );

      const cbCtx = createMockCallbackCtx(cancelData, 123);
      await handleCb(cbCtx as any);

      expect(cbCtx.answerCbQuery).toHaveBeenCalledWith('Cancelled.');
      expect(mockError).toHaveBeenCalledWith(
        expect.stringContaining('Failed to clean up'),
        expect.any(Error),
      );
    });

    it('deletes file and does not upload on cancel', async () => {
      const { cancelData } = await triggerPostDownloadConfirmation();
      jest.clearAllMocks();

      const cbCtx = createMockCallbackCtx(cancelData, 123);
      await handleCb(cbCtx as any);

      expect(cbCtx.answerCbQuery).toHaveBeenCalledWith('Cancelled.');
      expect(mockDownloadVideo).not.toHaveBeenCalled();
      expect(mockSendVideo).not.toHaveBeenCalled();
      // Should delete the downloaded file
      expect(mockUnlink).toHaveBeenCalledWith('unknown-duration.mp4');
    });
  });
});
