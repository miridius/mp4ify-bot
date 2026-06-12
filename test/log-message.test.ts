import { beforeEach, describe, expect, it, jest, mock, spyOn } from 'bun:test';
import { LogMessage, NoLog, type LogDest } from '../src/log-message';
import { spyMock } from './test-utils';

spyMock(console, 'debug');
beforeEach(() => jest.clearAllMocks());

let nextMsgId = 100;
const makeTg = () =>
  ({
    sendMessage: mock(async (_chatId: number, text: string) => ({
      text,
      chat: { id: 123 },
      message_id: nextMsgId++,
    })),
    editMessageText: mock(
      async (_chatId: any, msgId: any, _unused: any, text: string) => ({
        text,
        chat: { id: 123 },
        message_id: msgId,
      }),
    ),
  }) as any;
const dest: LogDest = { chatId: 123, chatType: 'private', replyTo: 1 };

describe('LogMessage', () => {
  it('appends and flushes a single line', async () => {
    const tg = makeTg();
    const log = new LogMessage(tg, dest, 'hello');
    await log.flush();
    expect(tg.sendMessage).toHaveBeenCalledWith(
      123,
      'hello',
      expect.objectContaining({
        reply_parameters: { message_id: 1 },
        parse_mode: 'HTML',
      }),
    );
  });

  it('splits messages if too long', async () => {
    const tg = makeTg();
    const log = new LogMessage(tg, dest);
    log.append('a'.repeat(4090));
    log.append('b'.repeat(20));
    await log.flush();
    expect(tg.sendMessage).toHaveBeenCalledTimes(2);
    expect(tg.sendMessage.mock.calls[1][1]).toContain('<i>...continued...</i>');
  });

  it('edits message if text changes', async () => {
    const tg = makeTg();
    const log = new LogMessage(tg, dest, 'foo');
    await log.flush();
    log.append('bar');
    await log.flush();
    expect(tg.editMessageText).toHaveBeenCalled();
  });

  it('does nothing if not private chat', async () => {
    const tg = makeTg();
    const log = new LogMessage(
      tg,
      { ...dest, chatType: 'group' },
      'should not log',
    );
    await log.flush();
    expect(tg.sendMessage).not.toHaveBeenCalled();
  });

  it('flushes automatically after the debounce delay', async () => {
    const tg = makeTg();
    new LogMessage(tg, dest, 'debounced');
    expect(tg.sendMessage).not.toHaveBeenCalled();
    await Bun.sleep(200); // DEBOUNCE_MS is 150
    expect(tg.sendMessage).toHaveBeenCalledWith(
      123,
      'debounced',
      expect.anything(),
    );
  });

  it('retries a failed initial reply on the next flush', async () => {
    const tg = makeTg();
    const mockError = spyMock(console, 'error');
    tg.sendMessage.mockImplementationOnce(() =>
      Promise.reject(new Error('429: Too Many Requests')),
    );
    const log = new LogMessage(tg, dest, 'hello');
    await log.flush(); // must not throw
    expect(mockError).toHaveBeenCalledTimes(1);
    await log.flush();
    expect(tg.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('does not leak an unhandled rejection when the debounced flush fails', async () => {
    const tg = makeTg();
    const mockError = spyMock(console, 'error');
    tg.sendMessage.mockImplementationOnce(() =>
      Promise.reject(new Error('chat deleted')),
    );
    new LogMessage(tg, dest, 'debounced');
    await Bun.sleep(200); // let the debounce timer fire
    expect(mockError).toHaveBeenCalled();
  });

  it('catches unexpected flush failures from the debounce timer', async () => {
    const tg = makeTg();
    const mockError = spyMock(console, 'error');
    const log = new LogMessage(tg, dest);
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
    const tg = makeTg();
    const mockError = spyMock(console, 'error');
    const log = new LogMessage(tg, dest, 'foo');
    await log.flush();
    tg.editMessageText.mockRejectedValueOnce(
      new Error('message is not modified'),
    );
    log.append('bar');
    await log.flush();
    expect(mockError).toHaveBeenCalledTimes(1);
    // Re-flushing the same content must not attempt another edit
    await log.flush();
    expect(tg.editMessageText).toHaveBeenCalledTimes(1);
  });
});

describe('NoLog', () => {
  it('does nothing', async () => {
    const log = new NoLog();
    log.append('bar');
    await log.flush();
  });
});
