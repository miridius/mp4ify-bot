import { mock, spyOn } from 'bun:test';
import type { CallbackQueryContext, MessageContext } from '../src/types';

export const spyMock: typeof spyOn = (obj, k) =>
  spyOn(obj, k).mockImplementation(mock() as any);

spyMock(console, 'debug'); // suppress debug logs

/**
 * Sleeps until `fn()` returns truthy or `timeout` millis (default: 4000) have elapsed.
 */
export const waitUntil = async (fn: () => any, timeout = 4000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end && !fn()) await Bun.sleep(100);
};

let nextMsgId = 100;

// Helper to create a mock MessageContext
export const createMockMessageCtx = (
  isEdit: boolean,
  overrides?: { chat?: any; from?: any },
): MessageContext => {
  const chat = overrides?.chat ?? { id: 123, type: 'private' };
  const from = overrides?.from ?? { id: 123, is_bot: false };
  return {
    [isEdit ? 'editedMessage' : 'message']: {
      text: 'https://example.com',
      entities: [{ type: 'url', offset: 0, length: 19 }],
      message_id: 1,
      from,
      chat,
    },
    chat,
    reply: mock(async (text: string) => ({
      text,
      chat,
      message_id: nextMsgId++,
    })),
    telegram: {
      sendVideo: mock(),
      sendMessage: mock(async (_chatId: number, text: string) => ({
        text,
        chat,
        message_id: nextMsgId++,
      })),
      editMessageText: mock(async (_chatId: any, _msgId: any, _unused: any, text: string) => ({
        text,
        chat,
        message_id: _msgId,
      })),
    },
  } as any;
};

// Helper to create a mock CallbackQueryContext
export const createMockCallbackCtx = (
  data: string,
  userId: number = 123,
): CallbackQueryContext =>
  ({
    callbackQuery: {
      id: '12345',
      from: { id: userId, is_bot: false, first_name: 'Test' },
      message: {
        message_id: 50,
        from: { id: 999, is_bot: true },
        chat: { id: userId, type: 'private' },
        text: 'Download this video?',
      },
      chat_instance: String(userId),
      data,
    },
    from: { id: userId, is_bot: false },
    answerCbQuery: mock(async () => {}),
    deleteMessage: mock(async () => {}),
    editMessageText: mock(async () => {}),
  }) as any;
