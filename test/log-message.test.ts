import { describe, expect, it } from 'bun:test';
import { LogMessage, NoLog } from '../src/log-message';
import { createMockMessageCtx, spyMock } from './test-utils';

spyMock(console, 'debug');

describe.each([false, true])('LogMessage, edit: %p', (isEdit) => {
  it('appends and flushes a single line', async () => {
    const ctx = createMockMessageCtx(isEdit);
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
    const ctx = createMockMessageCtx(isEdit);
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
    const ctx = createMockMessageCtx(isEdit);
    const log = new LogMessage(ctx, 'foo');
    await log.flush();
    log.append('bar');
    await log.flush();
    expect(ctx.telegram.editMessageText).toHaveBeenCalled();
  });

  it('does nothing if not private chat', async () => {
    const ctx = createMockMessageCtx(isEdit);
    ctx.chat.type = 'group';
    const log = new LogMessage(ctx, 'should not log');
    await log.flush();
    expect(ctx.reply).not.toHaveBeenCalled();
  });
});

describe('NoLog', () => {
  it('does nothing', async () => {
    const ctx = createMockMessageCtx(false);
    const log = new NoLog(ctx, 'foo');
    log.append('bar');
    await log.flush();
    expect(ctx.reply).not.toHaveBeenCalled();
  });
});
