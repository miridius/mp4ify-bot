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
import * as classifyUrl from '../src/classify-url.ts';
import * as downloadVideo from '../src/download-video.ts';
import {
  callbackQueryHandler,
  inlineQueryHandler,
  textMessageHandler,
} from '../src/handlers';
import * as logMessage from '../src/log-message.ts';
import * as pendingDownloads from '../src/pending-downloads.ts';
import { memoize } from '../src/utils.ts';
import {
  createMockCallbackCtx,
  createMockMessageCtx,
  spyMock,
} from './test-utils.ts';

beforeEach(() => {
  jest.clearAllMocks();
  pendingDownloads.clearPending();
});
afterAll(() => mock.restore());
spyMock(console, 'debug'); // suppress debug logs
const mockUnlink = spyOn(fsPromises, 'unlink').mockResolvedValue(undefined);

const mockLog = { append: mock(), flush: mock() };
spyOn(logMessage, 'LogMessage').mockReturnValue(mockLog as never);

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
const mockClassifyUrl = spyOn(classifyUrl, 'classifyUrl').mockResolvedValue(
  'video',
);

describe.each([false, true])('textMessageHandler, edit: %p', (isEdit) => {
  it('handles a message with a URL', async () => {
    const ctx = createMockMessageCtx(isEdit);
    await textMessageHandler(ctx as any);
    expect(mockGetInfo).toHaveBeenCalled();
    expect(mockSendInfo).toHaveBeenCalled();
    expect(mockDownloadVideo).toHaveBeenCalled();
    expect(mockSendVideo).toHaveBeenCalled();
  });

  it('handles download errors gracefully', async () => {
    const ctx = createMockMessageCtx(isEdit);
    mockGetInfo.mockRejectedValueOnce(new Error('oh noes!'));
    const mockError = spyOn(console, 'error').mockImplementationOnce(() => {});
    await textMessageHandler(ctx as any);
    // Should append error to log and flush, but not throw
    expect(mockGetInfo).toHaveBeenCalled();
    expect(mockError).toHaveBeenCalledTimes(1);
    expect(mockLog.append).toHaveBeenCalledWith(
      '\n💥 <b>Download failed</b>: oh noes!',
    );
  });

  it('does nothing if no url entities', async () => {
    const ctx = createMockMessageCtx(isEdit);
    (ctx.message || ctx.editedMessage).entities = [];
    await textMessageHandler(ctx);
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
    await textMessageHandler(msgCtx as any);
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
      await textMessageHandler(ctx as any);

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
      await textMessageHandler(ctx as any);

      const [, text] = (ctx.telegram.sendMessage as any).mock.calls[0];
      expect(text).toBe('This video is pretty long (25m 30s), do you want me to download it anyway?');
    });

    it('downloads immediately for video >20 min in private chat', async () => {
      mockGetInfoLong();
      const ctx = createMockMessageCtx(isEdit);
      await textMessageHandler(ctx as any);

      // Private chats skip confirmation
      expect(mockDownloadVideo).toHaveBeenCalled();
      expect(mockSendVideo).toHaveBeenCalled();
    });

    it('downloads immediately for video <=20 min in group chat', async () => {
      mockGetInfoShort();
      const ctx = createMockMessageCtx(isEdit, { chat: groupChat });
      await textMessageHandler(ctx as any);

      expect(mockDownloadVideo).toHaveBeenCalled();
      expect(mockSendVideo).toHaveBeenCalled();
    });

    it('probes duration after download in group chats even when duration is known', async () => {
      mockGetInfoShort(5 * 60); // 5 min known duration
      mockProbeDuration.mockResolvedValueOnce(5 * 60);
      const ctx = createMockMessageCtx(isEdit, { chat: groupChat });
      await textMessageHandler(ctx as any);

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
      await callbackQueryHandler(cbCtx as any);

      expect(cbCtx.answerCbQuery).toHaveBeenCalledWith('Starting download...');
      expect(cbCtx.deleteMessage).toHaveBeenCalled();
      expect(mockDownloadVideo).toHaveBeenCalled();
      expect(mockSendVideo).toHaveBeenCalled();
    });

    it('allows a different group member to confirm download', async () => {
      const { confirmData } = await triggerConfirmation();

      // User 999 (not the requester 123) clicks Download — should work
      const cbCtx = createMockCallbackCtx(confirmData, 999);
      await callbackQueryHandler(cbCtx as any);

      expect(cbCtx.answerCbQuery).toHaveBeenCalledWith('Starting download...');
      expect(mockDownloadVideo).toHaveBeenCalled();
      expect(mockSendVideo).toHaveBeenCalled();
    });

    it('cancels download when requester clicks Cancel', async () => {
      const { cancelData } = await triggerConfirmation();

      const cbCtx = createMockCallbackCtx(cancelData, 123);
      await callbackQueryHandler(cbCtx as any);

      expect(cbCtx.answerCbQuery).toHaveBeenCalledWith('Cancelled.');
      expect(cbCtx.deleteMessage).toHaveBeenCalled();
      expect(mockDownloadVideo).not.toHaveBeenCalled();
      expect(mockSendVideo).not.toHaveBeenCalled();
    });

    it('rejects cancel from non-requester', async () => {
      const { cancelData } = await triggerConfirmation();

      // User 999 tries to cancel — only requester (123) should be allowed
      const cbCtx = createMockCallbackCtx(cancelData, 999);
      await callbackQueryHandler(cbCtx as any);

      expect(cbCtx.answerCbQuery).toHaveBeenCalledWith(
        "Only the requester can cancel.",
      );
      expect(mockDownloadVideo).not.toHaveBeenCalled();
    });

    it('responds with unavailable for unknown callback data', async () => {
      const cbCtx = createMockCallbackCtx('dl:nonexistent', 123);
      await callbackQueryHandler(cbCtx as any);

      expect(cbCtx.answerCbQuery).toHaveBeenCalledWith(
        'This request is no longer available.',
      );
      expect(mockDownloadVideo).not.toHaveBeenCalled();
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
      mockDownloadVideo.mockRejectedValueOnce(new Error('network fail'));
      const mockError = spyOn(console, 'error').mockImplementation(() => {});

      const cbCtx = createMockCallbackCtx(confirmData, 123);
      await callbackQueryHandler(cbCtx as any);

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
      await textMessageHandler(ctx as any);

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
      await textMessageHandler(ctx as any);

      expect(mockDownloadVideo).toHaveBeenCalled();
      expect(mockSendVideo).not.toHaveBeenCalled();
      expect(ctx.telegram.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('downloads and uploads immediately when duration unknown and ffprobe finds <=20min', async () => {
      mockGetInfoNoDuration();
      mockProbeDuration.mockResolvedValueOnce(5 * 60); // 5 minutes
      const ctx = createMockMessageCtx(isEdit, { chat: groupChat });
      await textMessageHandler(ctx as any);

      expect(mockDownloadVideo).toHaveBeenCalled();
      expect(mockSendVideo).toHaveBeenCalled();
    });

    it('downloads and uploads immediately when duration unknown and ffprobe fails', async () => {
      mockGetInfoNoDuration();
      mockProbeDuration.mockResolvedValueOnce(undefined);
      const ctx = createMockMessageCtx(isEdit, { chat: groupChat });
      await textMessageHandler(ctx as any);

      expect(mockDownloadVideo).toHaveBeenCalled();
      expect(mockSendVideo).toHaveBeenCalled();
    });

    it('private chat with unknown duration downloads and uploads without any confirmation', async () => {
      mockGetInfoNoDuration();
      const ctx = createMockMessageCtx(isEdit); // private chat
      await textMessageHandler(ctx as any);

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
      await textMessageHandler(msgCtx as any);
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
      await callbackQueryHandler(cbCtx as any);

      expect(cbCtx.answerCbQuery).toHaveBeenCalledWith('Starting download...');
      // Should NOT re-download
      expect(mockDownloadVideo).not.toHaveBeenCalled();
      // Should upload
      expect(mockSendVideo).toHaveBeenCalled();
    });

    it('deletes file and does not upload on cancel', async () => {
      const { cancelData } = await triggerPostDownloadConfirmation();
      jest.clearAllMocks();

      const cbCtx = createMockCallbackCtx(cancelData, 123);
      await callbackQueryHandler(cbCtx as any);

      expect(cbCtx.answerCbQuery).toHaveBeenCalledWith('Cancelled.');
      expect(mockDownloadVideo).not.toHaveBeenCalled();
      expect(mockSendVideo).not.toHaveBeenCalled();
      // Should delete the downloaded file
      expect(mockUnlink).toHaveBeenCalledWith('unknown-duration.mp4');
    });
  });
});

describe('article detection for generic extractor in group chats', () => {
  const groupChat = { id: -100, type: 'group', title: 'Test Group' };

  const mockGetInfoGeneric = (extractor: string = 'generic') =>
    mockGetInfo.mockImplementation(
      memoize(
        mock(async (_log: any, url: string) => ({
          webpage_url: url,
          title: 'Some Page Title',
          extractor,
          id: 'id',
          description: 'desc',
          filename: 'video.mp4',
          duration: 60,
        })),
      ),
    );

  describe.each([false, true])('textMessageHandler, edit: %p', (isEdit) => {
    it('asks for confirmation when generic extractor + article URL in group chat', async () => {
      mockGetInfoGeneric();
      mockClassifyUrl.mockResolvedValueOnce('article');
      const ctx = createMockMessageCtx(isEdit, { chat: groupChat });
      await textMessageHandler(ctx as any);

      // Should NOT download
      expect(mockDownloadVideo).not.toHaveBeenCalled();
      expect(mockSendVideo).not.toHaveBeenCalled();

      // Should have called classifyUrl
      expect(mockClassifyUrl).toHaveBeenCalledWith(
        'https://example.com',
        'Some Page Title',
      );

      // Should send confirmation message
      expect(ctx.telegram.sendMessage).toHaveBeenCalledTimes(1);
      const [chatId, text, opts] = (ctx.telegram.sendMessage as any).mock
        .calls[0];
      expect(chatId).toBe(-100);
      expect(text).toBe(
        'This looks like a news article, but it has an embedded video. Do you want me to extract the video?',
      );
      expect(opts.reply_markup.inline_keyboard[0]).toHaveLength(2);
      expect(opts.reply_markup.inline_keyboard[0][0].callback_data).toMatch(
        /^dl:/,
      );
      expect(opts.reply_markup.inline_keyboard[0][1].callback_data).toMatch(
        /^no:/,
      );
    });

    it('asks for confirmation with generic:quoted-html extractor', async () => {
      mockGetInfoGeneric('generic:quoted-html');
      mockClassifyUrl.mockResolvedValueOnce('article');
      const ctx = createMockMessageCtx(isEdit, { chat: groupChat });
      await textMessageHandler(ctx as any);

      expect(mockClassifyUrl).toHaveBeenCalled();
      expect(mockDownloadVideo).not.toHaveBeenCalled();
      expect(ctx.telegram.sendMessage).toHaveBeenCalledTimes(1);
      const [, text] = (ctx.telegram.sendMessage as any).mock.calls[0];
      expect(text).toContain('news article');
    });

    it('proceeds normally when generic extractor + video URL in group chat', async () => {
      mockGetInfoGeneric();
      mockClassifyUrl.mockResolvedValueOnce('video');
      const ctx = createMockMessageCtx(isEdit, { chat: groupChat });
      await textMessageHandler(ctx as any);

      expect(mockClassifyUrl).toHaveBeenCalled();
      expect(mockDownloadVideo).toHaveBeenCalled();
      expect(mockSendVideo).toHaveBeenCalled();
    });

    it('skips Haiku check for non-generic extractors in group chat', async () => {
      // Default mock returns extractor: 'test', so classifyUrl should NOT be called
      const ctx = createMockMessageCtx(isEdit, { chat: groupChat });
      await textMessageHandler(ctx as any);

      expect(mockClassifyUrl).not.toHaveBeenCalled();
      expect(mockDownloadVideo).toHaveBeenCalled();
      expect(mockSendVideo).toHaveBeenCalled();
    });

    it('skips Haiku check in private chat even with generic extractor', async () => {
      mockGetInfoGeneric();
      const ctx = createMockMessageCtx(isEdit); // private chat
      await textMessageHandler(ctx as any);

      expect(mockClassifyUrl).not.toHaveBeenCalled();
      expect(mockDownloadVideo).toHaveBeenCalled();
      expect(mockSendVideo).toHaveBeenCalled();
    });

    it('proceeds normally if classifyUrl fails', async () => {
      mockGetInfoGeneric();
      mockClassifyUrl.mockRejectedValueOnce(new Error('API down'));
      const mockWarn = spyOn(console, 'warn').mockImplementationOnce(() => {});
      const ctx = createMockMessageCtx(isEdit, { chat: groupChat });
      await textMessageHandler(ctx as any);

      // Should fall through and download anyway
      expect(mockDownloadVideo).toHaveBeenCalled();
      expect(mockSendVideo).toHaveBeenCalled();
      expect(mockWarn).toHaveBeenCalled();
    });
  });

  describe('callbackQueryHandler (article confirmation)', () => {
    const triggerArticleConfirmation = async () => {
      mockGetInfoGeneric();
      mockClassifyUrl.mockResolvedValueOnce('article');
      const msgCtx = createMockMessageCtx(false, { chat: groupChat });
      await textMessageHandler(msgCtx as any);
      const buttons = (msgCtx.telegram.sendMessage as any).mock.calls[0][2]
        .reply_markup.inline_keyboard[0];
      return {
        msgCtx,
        confirmData: buttons[0].callback_data as string,
        cancelData: buttons[1].callback_data as string,
      };
    };

    it('downloads after user confirms article video', async () => {
      const { confirmData } = await triggerArticleConfirmation();

      const cbCtx = createMockCallbackCtx(confirmData, 123);
      await callbackQueryHandler(cbCtx as any);

      expect(cbCtx.answerCbQuery).toHaveBeenCalledWith('Starting download...');
      expect(cbCtx.deleteMessage).toHaveBeenCalled();
      expect(mockDownloadVideo).toHaveBeenCalled();
      expect(mockSendVideo).toHaveBeenCalled();
    });

    it('cancels after user declines article video', async () => {
      const { cancelData } = await triggerArticleConfirmation();

      const cbCtx = createMockCallbackCtx(cancelData, 123);
      await callbackQueryHandler(cbCtx as any);

      expect(cbCtx.answerCbQuery).toHaveBeenCalledWith('Cancelled.');
      expect(cbCtx.deleteMessage).toHaveBeenCalled();
      expect(mockDownloadVideo).not.toHaveBeenCalled();
      expect(mockSendVideo).not.toHaveBeenCalled();
    });
  });
});
