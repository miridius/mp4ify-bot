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
import * as handlers from '../src/handlers';
import { spyMock } from './test-utils';

beforeEach(() => jest.clearAllMocks());
afterAll(() => mock.restore());

spyOn(Telegraf.prototype, 'launch').mockImplementation(async function () {
  await Bun.sleep(10);
  (this as any).polling = true;
});

// Mock ./handlers
const textMessageHandler = spyMock(handlers, 'textMessageHandler');
const inlineQueryHandler = spyMock(handlers, 'inlineQueryHandler');

// Mock Bun.sleep
const sleepSpy = spyOn(Bun, 'sleep');

// Mock process.once
const processOnce = spyMock(process, 'once');

describe('start', async () => {
  const botToken = 'test-token';

  const bot = await start(botToken);

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

  it('waits for polling to be true before continuing', async () => {
    const bot = await start('test-token');
    expect((bot as any).polling).toBeTruthy();
    expect(sleepSpy).toHaveBeenCalledWith(100);
  });
});
