import { describe, expect, it, mock } from 'bun:test';
import { LogMessage, NoLog } from '../src/log-message';
import type { MessageContext } from '../src/types';
import { spyMock } from './test-utils';

spyMock(console, 'debug');

function createMockCtx(): MessageContext {
  const reply = mock(async (text, opts) => ({
    text,
    chat: { id: 123, type: 'private' },
    message_id: Math.floor(Math.random() * 1000),
    ...opts,
  }));
  const editMessageText = mock(async (_chatId, _msgId, _unused, text) => ({
    text,
    chat: { id: 123, type: 'private' },
    message_id: _msgId,
  }));

  return {
    message: {
      message_id: 1,
      chat: { id: 123, type: 'private' },
    },
    chat: { id: 123, type: 'private' },
    reply,
    telegram: {
      editMessageText,
    },
  } as unknown as MessageContext;
}

describe('LogMessage', () => {
  it('appends and flushes a single line', async () => {
    const ctx = createMockCtx();
    const log = new LogMessage(ctx, 'hello');
    await log.flush();
    expect(ctx.reply).toHaveBeenCalledWith(
      'hello',
      expect.objectContaining({
        reply_parameters: { message_id: 1 },
        parse_mode: 'HTML',
      }),
    );
  });

  it('splits messages if too long', async () => {
    const ctx = createMockCtx();
    const log = new LogMessage(ctx);
    const longLine = 'a'.repeat(4090);
    log.append(longLine);
    log.append('b'.repeat(20));
    await log.flush();
    expect(ctx.reply).toHaveBeenCalledTimes(2);
    expect((ctx.reply as any).mock.calls[1][0]).toContain(
      '<i>...continued...</i>',
    );
  });

  it('edits message if text changes', async () => {
    const ctx = createMockCtx();
    const log = new LogMessage(ctx, 'foo');
    await log.flush();
    log.append('bar');
    await log.flush();
    expect(ctx.telegram.editMessageText).toHaveBeenCalled();
  });

  it('does nothing if not private chat', async () => {
    const ctx = createMockCtx();
    ctx.chat.type = 'group';
    const log = new LogMessage(ctx, 'should not log');
    await log.flush();
    expect(ctx.reply).not.toHaveBeenCalled();
  });
});

describe('NoLog', () => {
  it('does nothing', async () => {
    const ctx = createMockCtx();
    const log = new NoLog(ctx, 'foo');
    log.append('bar');
    await log.flush();
    expect(ctx.reply).not.toHaveBeenCalled();
  });
});
