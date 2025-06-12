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
import type { Message } from 'telegraf/types';
import * as downloadVideo from '../src/download-video.ts';
import { inlineQueryHandler, textMessageHandler } from '../src/handlers';
import * as logMessage from '../src/log-message.ts';
import { memoize } from '../src/utils.ts';
import { createMockMessageCtx, spyMock } from './test-utils.ts';

beforeEach(() => jest.clearAllMocks());
afterAll(() => mock.restore());
spyMock(console, 'debug'); // suppress debug logs

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

  it('handles errors gracefully', async () => {
    const ctx = createMockInlineQueryCtx();
    mockGetInfo.mockRejectedValue(new Error('fail!'));
    const mockError = spyOn(console, 'error').mockImplementationOnce(() => {});

    await inlineQueryHandler(ctx as any);
    // Should not throw
    expect(ctx.answerInlineQuery).not.toHaveBeenCalled();
    expect(mockError).toHaveBeenCalledTimes(1);
  });
});
