import { mock, spyOn } from 'bun:test';
import type { MessageContext } from '../src/types';

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

// Helper to create a mock MessageContext
export const createMockMessageCtx = (isEdit: boolean): MessageContext =>
  ({
    [isEdit ? 'editedMessage' : 'message']: {
      text: 'https://example.com',
      entities: [{ type: 'url', offset: 0, length: 19 }],
      message_id: 1,
      chat: { id: 123, type: 'private' },
    },
    chat: { id: 123, type: 'private' },
    reply: mock(async (text, opts) => ({
      text,
      chat: { id: 123, type: 'private' },
      message_id: Math.floor(Math.random() * 1000),
      ...opts,
    })),
    telegram: {
      sendVideo: mock(),
      editMessageText: mock(async (_chatId, _msgId, _unused, text) => ({
        text,
        chat: { id: 123, type: 'private' },
        message_id: _msgId,
      })),
    },
  }) as any;
