import { describe, expect, it, spyOn } from 'bun:test';
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

  it('flushes automatically after the debounce delay', async () => {
    const ctx = createMockMessageCtx(isEdit);
    new LogMessage(ctx, 'debounced');
    expect(ctx.reply).not.toHaveBeenCalled();
    await Bun.sleep(200); // DEBOUNCE_MS is 150
    expect(ctx.reply).toHaveBeenCalledWith('debounced', expect.anything());
  });

  it('retries a failed initial reply on the next flush', async () => {
    const ctx = createMockMessageCtx(isEdit);
    const mockError = spyMock(console, 'error');
    mockError.mockClear();
    (ctx.reply as any).mockImplementationOnce(() =>
      Promise.reject(new Error('429: Too Many Requests')),
    );
    const log = new LogMessage(ctx, 'hello');
    await log.flush(); // must not throw
    expect(mockError).toHaveBeenCalledTimes(1);
    await log.flush();
    expect(ctx.reply).toHaveBeenCalledTimes(2); // retried
  });

  it('does not leak an unhandled rejection when the debounced flush fails', async () => {
    const ctx = createMockMessageCtx(isEdit);
    const mockError = spyMock(console, 'error');
    mockError.mockClear();
    (ctx.reply as any).mockImplementationOnce(() =>
      Promise.reject(new Error('chat deleted')),
    );
    new LogMessage(ctx, 'debounced');
    await Bun.sleep(200); // let the debounce timer fire
    expect(mockError).toHaveBeenCalled();
  });

  it('catches unexpected flush failures from the debounce timer', async () => {
    const ctx = createMockMessageCtx(isEdit);
    const mockError = spyMock(console, 'error');
    mockError.mockClear();
    const log = new LogMessage(ctx);
    spyOn(log as any, 'flush').mockImplementationOnce(() =>
      Promise.reject(new Error('unexpected')),
    );
    log.append('x');
    await Bun.sleep(200); // let the debounce timer fire
    expect(mockError).toHaveBeenCalledWith(
      'Log flush failed:',
      expect.any(Error),
    );
  });

  it('does not retry failed edits with the same content', async () => {
    const ctx = createMockMessageCtx(isEdit);
    const mockError = spyMock(console, 'error');
    mockError.mockClear(); // spy persists across the describe.each variants
    const log = new LogMessage(ctx, 'foo');
    await log.flush();
    (ctx.telegram.editMessageText as any).mockRejectedValueOnce(
      new Error('message is not modified'),
    );
    log.append('bar');
    await log.flush();
    expect(mockError).toHaveBeenCalledTimes(1);
    // Re-flushing the same content must not attempt another edit
    await log.flush();
    expect(ctx.telegram.editMessageText).toHaveBeenCalledTimes(1);
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
