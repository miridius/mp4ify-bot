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
// import * as telegraf from 'telegraf';
// import * as telegrafFilters from 'telegraf/filters';
import { Telegraf } from 'telegraf';
import type { Message, Update } from 'telegraf/types';
import { start } from '../src/bot';
import { apiRoot } from '../src/consts';
import * as downloadVideo from '../src/download-video';
import {
  DOWNLOAD_TIMEOUT_SECS,
  YTDLP_UPDATE_INTERVAL_MS,
} from '../src/download-video';
import * as handlers from '../src/handlers';
import { spyMock } from './test-utils';

beforeEach(() => jest.clearAllMocks());
afterAll(() => mock.restore());

let launched = false;
spyOn(Telegraf.prototype, 'launch').mockImplementation(async function (
  ...args: any[]
) {
  await Bun.sleep(10);
  launched = true;
  (this as any).polling = {}; // telegraf assigns this when polling starts
  // like the real launch(): invoke onLaunch, then stay pending
  args.find((a) => typeof a === 'function')?.();
  return new Promise<never>(() => {});
});

// Mock ./handlers
const textMessageHandler = spyMock(handlers, 'textMessageHandler');
const inlineQueryHandler = spyMock(handlers, 'inlineQueryHandler');
const callbackQueryHandler = spyMock(handlers, 'callbackQueryHandler');

// Mock the yt-dlp self-update (and watch setInterval to check it's scheduled)
const updateYtdlp = spyMock(downloadVideo, 'updateYtdlp');
const setIntervalSpy = spyOn(globalThis, 'setInterval');

// Mock process.once
const processOnce = spyMock(process, 'once');

describe('start', async () => {
  const botToken = 'test-token';

  const bot = await start(botToken);

  // updates yt-dlp on start and schedules a daily update
  expect(updateYtdlp).toHaveBeenCalledTimes(1);
  expect(setIntervalSpy).toHaveBeenCalledWith(
    updateYtdlp,
    YTDLP_UPDATE_INTERVAL_MS,
  );

  expect(processOnce).toHaveBeenCalledWith('SIGINT', expect.any(Function));
  expect(processOnce).toHaveBeenCalledWith('SIGTERM', expect.any(Function));

  bot.stop = mock();
  processOnce.mock.calls.find(([signal]) => signal === 'SIGINT')![1]();
  expect(bot.stop).toHaveBeenCalledWith('SIGINT');

  processOnce.mock.calls.find(([signal]) => signal === 'SIGTERM')![1]();
  expect(bot.stop).toHaveBeenCalledWith('SIGTERM');

  it('constructs Telegraf with correct args', () => {
    expect(bot.telegram.token).toBe(botToken);
    expect(bot.telegram.options.apiRoot).toBe(apiRoot);
  });

  bot.telegram.getMe = mock(); // telegraf calls getMe when handling updates

  it('calls textMessageHandler with text messages', async () => {
    const msgUpdate: Update.MessageUpdate<Message.TextMessage> = {
      update_id: 1,
      message: {
        message_id: 2,
        date: Math.floor(Date.now() / 1000),
        text: 'foo',
        chat: { id: 123, type: 'private', first_name: 'Test' },
        from: {
          id: 456,
          is_bot: false,
          first_name: 'Test',
          username: 'testuser',
        },
      },
    };
    await bot.handleUpdate(msgUpdate);
    expect(textMessageHandler).toBeCalledTimes(1);
    expect(textMessageHandler.mock.calls[0]![0].update).toEqual(msgUpdate);
  });

  it('calls textMessageHandler with text message edits in private chats', async () => {
    const privateEdit: Update.EditedMessageUpdate<Message.TextMessage> = {
      update_id: 1,
      edited_message: {
        message_id: 2,
        date: Math.floor(Date.now() / 1000),
        edit_date: Math.floor(Date.now() / 1000),
        text: 'bar',
        chat: { id: 123, type: 'private', first_name: 'Test' },
        from: {
          id: 456,
          is_bot: false,
          first_name: 'Test',
          username: 'testuser',
        },
      },
    };
    await bot.handleUpdate(privateEdit);
    expect(textMessageHandler).toBeCalledTimes(1);
    expect(textMessageHandler.mock.calls[0]![0].update).toEqual(privateEdit);
  });

  it('does not call textMessageHandler with text message edits in group chats', async () => {
    const groupEdit: Update.EditedMessageUpdate<Message.TextMessage> = {
      update_id: 1,
      edited_message: {
        message_id: 2,
        date: Math.floor(Date.now() / 1000),
        edit_date: Math.floor(Date.now() / 1000),
        text: 'bar',
        chat: { id: 123, type: 'group', title: 'Test Group' },
        from: {
          id: 456,
          is_bot: false,
          first_name: 'Test',
          username: 'testuser',
        },
      },
    };
    const mockLog = spyMock(console, 'log');
    await bot.handleUpdate(groupEdit);
    expect(textMessageHandler).toBeCalledTimes(0);
    expect(mockLog).toBeCalledWith('unhandled update:', groupEdit);
  });

  it('calls inlineQueryHandler with inline queries', async () => {
    const inlineQuery: Update.InlineQueryUpdate = {
      update_id: 1,
      inline_query: {
        id: 'abc123',
        from: {
          id: 456,
          is_bot: false,
          first_name: 'Test',
          username: 'testuser',
        },
        query: 'test',
        offset: '',
        chat_type: 'private',
      },
    };
    await bot.handleUpdate(inlineQuery);
    expect(inlineQueryHandler).toBeCalledTimes(1);
    expect(inlineQueryHandler.mock.calls[0]![0].update).toEqual(inlineQuery);
  });

  it('calls callbackQueryHandler with callback queries', async () => {
    const callbackQuery: Update.CallbackQueryUpdate = {
      update_id: 1,
      callback_query: {
        id: 'cb123',
        from: {
          id: 456,
          is_bot: false,
          first_name: 'Test',
          username: 'testuser',
        },
        chat_instance: '456',
        data: 'dl:test-id',
      },
    };
    await bot.handleUpdate(callbackQuery);
    expect(callbackQueryHandler).toBeCalledTimes(1);
    expect(callbackQueryHandler.mock.calls[0]![0].update).toEqual(callbackQuery);
  });

  it('resolves only once launch reports the bot has started', async () => {
    launched = false; // suite-level start() already set it; reset to re-pin
    await start('test-token');
    expect(launched).toBe(true);
  });

  it('sets handlerTimeout above the worst case of two sequential yt-dlp runs', () => {
    expect((bot as any).options.handlerTimeout).toBeGreaterThan(
      2 * DOWNLOAD_TIMEOUT_SECS * 1000,
    );
  });

  it('exits the process if polling crashes fatally', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(mock());
    const exitSpy = spyOn(process, 'exit').mockImplementation(
      (() => undefined) as any,
    );
    (Telegraf.prototype.launch as any).mockImplementationOnce(async function (
      this: any,
      ...args: any[]
    ) {
      this.polling = {}; // crash strikes after polling had started
      args.find((a: any) => typeof a === 'function')?.();
      throw new Error('fatal polling error');
    });
    await start('crash-token');
    await Bun.sleep(1); // let the launch rejection reach the catch
    expect(consoleError).toHaveBeenCalledWith('Bot crashed:', expect.any(Error));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('contains handler errors instead of crashing the polling loop', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(mock());
    textMessageHandler.mockImplementationOnce(() =>
      Promise.reject(new Error('handler boom')),
    );
    const msgUpdate: Update.MessageUpdate<Message.TextMessage> = {
      update_id: 99,
      message: {
        message_id: 100,
        date: Math.floor(Date.now() / 1000),
        text: 'boom',
        chat: { id: 123, type: 'private', first_name: 'Test' },
        from: { id: 456, is_bot: false, first_name: 'Test' },
      },
    };
    // must resolve, not reject: a rejection escaping handleUpdate crashes the bot
    await bot.handleUpdate(msgUpdate);
    expect(consoleError).toHaveBeenCalledWith(
      'Unhandled error while processing',
      expect.anything(),
      expect.any(Error),
    );
    expect(process.exitCode).toBe(1);
    process.exitCode = 0; // don't fail the test run itself
  });
});
