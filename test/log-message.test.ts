import { beforeEach, describe, expect, it, jest, mock, spyOn } from 'bun:test';
import {
  LogMessage,
  logFor,
  NoLog,
  setRetryPassDelayMs,
  type LogDest,
} from '../src/log-message';
import { spyMock, telegramError } from './test-utils';

spyMock(console, 'debug');
beforeEach(() => jest.clearAllMocks());
// zero the inter-pass backoff so retry-pass tests don't pay real sleeps
beforeEach(() => setRetryPassDelayMs(0));

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
const dest: LogDest = { chatId: 123, replyTo: 1 };

// the deterministic 400 the parser returns for broken HTML (one factory so
// the wording can't drift between the tests that key on it)
const parseRejection = () =>
  telegramError(400, "Bad Request: can't parse entities: unclosed tag");

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
    // the retry seam reads the LAST chunk: that's where appends land, so
    // that's the message a retry must continue
    const lastSent = await tg.sendMessage.mock.results[1].value;
    expect(log.messageId).toBe(lastSent.message_id);
    expect(log.text).toContain('b'.repeat(20));
  });

  it('hard-splits a single line longer than one message', async () => {
    // stored whole, an oversize chunk could never send (Telegram rejects it
    // and no retry shrinks it), wedging the thread forever
    const tg = makeTg();
    const log = new LogMessage(tg, dest);
    log.append('x'.repeat(10_000));
    await log.flush();
    expect(tg.sendMessage).toHaveBeenCalledTimes(3);
    for (const [, text] of tg.sendMessage.mock.calls) {
      expect(text.length).toBeLessThanOrEqual(4096);
    }
    // nothing lost to the split
    const joined = tg.sendMessage.mock.calls
      .map(([, text]: [unknown, string]) => text.replaceAll(/<[^>]+>|\n/g, ''))
      .join('')
      .replaceAll('...continued...', '');
    expect(joined).toBe('x'.repeat(10_000));
  });

  it('backs off a hard split before a lone "<" with no closing ">"', async () => {
    // splitPoint must not cut just after a lone '<' (indexOf('>') returns -1):
    // a stranded '<co' partial is exactly what stripTags can't heal. Place a
    // lone '<' right before the split boundary and confirm no chunk strands it
    // mid-tag; every chunk still sends and the content round-trips.
    const tg = makeTg();
    const log = new LogMessage(tg, dest);
    const max = 4096 - '<i>...continued...</i>\n\n'.length;
    // a '<' one char before the natural boundary forces the backoff branch
    const line = 'y'.repeat(max - 1) + '<' + 'z'.repeat(5000);
    log.append(line);
    await log.flush();
    for (const [, text] of tg.sendMessage.mock.calls) {
      expect(text.length).toBeLessThanOrEqual(4096);
    }
    const joined = tg.sendMessage.mock.calls
      .map(([, text]: [unknown, string]) => text.replaceAll(/\n/g, ''))
      .join('')
      .replaceAll('<i>...continued...</i>', '');
    expect(joined).toBe(line);
  });

  it('edits message if text changes', async () => {
    const tg = makeTg();
    const log = new LogMessage(tg, dest, 'foo');
    await log.flush();
    log.append('bar');
    await log.flush();
    expect(tg.editMessageText).toHaveBeenCalled();
  });

  it('continues a seeded message below its prior content instead of wiping it', async () => {
    const tg = makeTg();
    // a retry carries the prior attempt's content in editText
    const log = new LogMessage(tg, {
      ...dest,
      editMessageId: 777,
      editText: 'scraping...\n⚠️ retrying (attempt 2 of 3)...',
    });
    log.append('attempt 2 progress');
    await log.flush();
    expect(tg.sendMessage).not.toHaveBeenCalled(); // continued, not re-posted
    expect(tg.editMessageText).toHaveBeenCalledWith(
      123,
      777,
      undefined,
      'scraping...\n⚠️ retrying (attempt 2 of 3)...\nattempt 2 progress',
      expect.anything(),
    );
  });

  it('does not touch a seeded message until something new is appended', async () => {
    const tg = makeTg();
    const log = new LogMessage(tg, {
      ...dest,
      editMessageId: 777,
      editText: 'prior content',
    });
    await log.flush();
    expect(tg.editMessageText).not.toHaveBeenCalled();
    expect(tg.sendMessage).not.toHaveBeenCalled();
  });

  it('edits an existing message when seeded with editMessageId (a retry)', async () => {
    const tg = makeTg();
    const log = new LogMessage(tg, { ...dest, editMessageId: 555 }, 'retry update');
    await log.flush();
    expect(tg.sendMessage).not.toHaveBeenCalled(); // no new reply
    expect(tg.editMessageText).toHaveBeenCalledWith(
      123,
      555,
      undefined,
      'retry update',
      expect.objectContaining({ parse_mode: 'HTML' }),
    );
    expect(log.messageId).toBe(555);
  });

  it('sends a fresh reply when the seeded message is gone (edit fails)', async () => {
    const tg = makeTg();
    spyMock(console, 'error');
    tg.editMessageText.mockRejectedValueOnce(
      new Error('Bad Request: message to edit not found'),
    );
    const log = new LogMessage(tg, { ...dest, editMessageId: 999 }, 'retry text');
    await log.flush();
    expect(tg.sendMessage).toHaveBeenCalledWith(
      123,
      'retry text',
      expect.anything(),
    );
  });

  it('repairs deterministically-rejected HTML within the same flush', async () => {
    const tg = makeTg();
    spyMock(console, 'error');
    const log = new LogMessage(tg, dest, 'foo');
    await log.flush(); // sends 'foo'
    // A parse rejection repeats identically on every attempt, so the broken
    // text is never retried verbatim; the chunk is sanitized and the SAME
    // flush delivers the parseable form (this may be the job's final flush,
    // so waiting for a later one would drop the update entirely).
    tg.editMessageText.mockRejectedValueOnce(parseRejection());
    log.append('<code>broken');
    await log.flush();
    expect(tg.editMessageText).toHaveBeenCalledTimes(2); // broken, then repaired
    expect(tg.editMessageText).toHaveBeenLastCalledWith(
      123,
      expect.anything(),
      undefined,
      'foo\nbroken',
      expect.anything(),
    );
    expect(tg.sendMessage).toHaveBeenCalledTimes(1); // never a duplicate reply

    // fully delivered: re-flushing attempts nothing
    await log.flush();
    expect(tg.editMessageText).toHaveBeenCalledTimes(2);
    expect(tg.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('builds later appends on the sanitized chunk after a parse-rejected edit', async () => {
    const tg = makeTg();
    spyMock(console, 'error');
    const log = new LogMessage(tg, dest, 'foo');
    await log.flush(); // sends 'foo'
    tg.editMessageText.mockRejectedValueOnce(
      parseRejection(),
    );
    log.append('<code>broken');
    await log.flush(); // rejected: the chunk is sanitized in place
    log.append('report'); // e.g. the terminal failure report
    await log.flush();
    // the report lands, built on the tag-stripped (parseable) chunk
    expect(tg.editMessageText).toHaveBeenLastCalledWith(
      123,
      expect.anything(),
      undefined,
      'foo\nbroken\nreport',
      expect.anything(),
    );
  });

  it('sanitizes a parse-rejected first send so the retry posts parseable text', async () => {
    const tg = makeTg();
    spyMock(console, 'error');
    // the send branch: no message exists yet, and the very first send is
    // rejected by the parser (same determinism as the edit branch)
    tg.sendMessage.mockRejectedValueOnce(
      parseRejection(),
    );
    const log = new LogMessage(tg, dest, '<code>broken');
    await log.flush();
    await log.flush(); // the retry must not re-send the same broken HTML
    expect(tg.sendMessage).toHaveBeenCalledTimes(2);
    expect(tg.sendMessage.mock.calls[1][1]).toBe('broken');
  });

  it('keeps an append that raced a parse-rejected send (sanitizes the live chunk)', async () => {
    const tg = makeTg();
    spyMock(console, 'error');
    let reject!: (e: any) => void;
    tg.sendMessage.mockImplementationOnce(
      () => new Promise((_r, rj) => (reject = rj)),
    );
    const log = new LogMessage(tg, dest, '<code>broken');
    const flushing = log.flush();
    await Bun.sleep(0); // let the flush reach sendMessage (now in flight)
    log.append('raced'); // lands while the send is pending
    reject(
      parseRejection(),
    );
    await flushing;
    await log.flush();
    // sanitizing this call's snapshot instead of the live chunk would have
    // clobbered the raced append; it must survive, stripped
    expect(tg.sendMessage.mock.calls[1][1]).toBe('broken\nraced');
  });

  it('retries the edit instead of sending a duplicate on a transient edit failure', async () => {
    const tg = makeTg();
    spyMock(console, 'error');
    const log = new LogMessage(tg, { ...dest, editMessageId: 777 }, 'first');
    await log.flush(); // edits the seeded message
    tg.editMessageText.mockImplementationOnce(() =>
      Promise.reject(new Error('429: Too Many Requests')),
    );
    log.append('second');
    await log.flush(); // transient edit failure: must NOT post a fresh reply
    expect(tg.sendMessage).not.toHaveBeenCalled();

    await log.flush(); // retries editing the same message
    expect(tg.editMessageText).toHaveBeenLastCalledWith(
      123,
      777,
      undefined,
      'first\nsecond',
      expect.anything(),
    );
    expect(log.messageId).toBe(777); // same message, no duplicate
  });

  it('treats a structured 5xx edit error as transient (keeps the message)', async () => {
    const tg = makeTg();
    spyMock(console, 'error');
    const log = new LogMessage(tg, { ...dest, editMessageId: 777 }, 'first');
    await log.flush();
    tg.editMessageText.mockImplementationOnce(() =>
      Promise.reject({
        response: { error_code: 500, description: 'Internal Server Error' },
      }),
    );
    log.append('second');
    await log.flush();
    expect(tg.sendMessage).not.toHaveBeenCalled(); // no duplicate reply
    expect(log.messageId).toBe(777);
  });

  it('does not lose an append that races an in-flight flush (self-healing)', async () => {
    const tg = makeTg();
    let release!: () => void;
    tg.sendMessage.mockImplementationOnce(
      (_c: any, text: string) =>
        new Promise((r) => {
          release = () => r({ text, chat: { id: 123 }, message_id: 100 });
        }),
    );
    const log = new LogMessage(tg, dest, 'first');
    const flushing = log.flush(); // 'first' send is in flight, awaiting release
    await Bun.sleep(0); // let doFlush call sendMessage (which sets `release`)
    log.append('second'); // appended mid-flush
    release();
    await flushing;
    await log.flush(); // the appended content flushes now

    expect(tg.editMessageText).toHaveBeenCalledWith(
      123,
      100,
      undefined,
      'first\nsecond',
      expect.anything(),
    );
  });

  it('leaves messageId undefined after a failed send (a retry posts fresh, no duplicate)', async () => {
    const tg = makeTg();
    spyMock(console, 'error');
    // rejects on EVERY attempt: the flush's bounded retry passes must give
    // up, and the stash then posts fresh next boot rather than editing a
    // message that never existed
    tg.sendMessage.mockImplementation(() => Promise.reject(new Error('429')));
    const log = new LogMessage(tg, dest, 'report');
    await log.flush(); // every send fails
    expect(log.messageId).toBeUndefined();
  });

  it('exposes the reply message_id once sent', async () => {
    const tg = makeTg();
    const log = new LogMessage(tg, dest, 'hello');
    expect(log.messageId).toBeUndefined();
    await log.flush();
    expect(typeof log.messageId).toBe('number');
  });

  it('does nothing without a destination', async () => {
    const tg = makeTg();
    const log = new LogMessage(tg, undefined, 'no dest');
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

  it('retries a failed initial reply within the same flush', async () => {
    const tg = makeTg();
    const mockError = spyMock(console, 'error');
    tg.sendMessage.mockImplementationOnce(() =>
      Promise.reject(new Error('429: Too Many Requests')),
    );
    const log = new LogMessage(tg, dest, 'hello');
    await log.flush(); // must not throw; the retry pass delivers
    expect(mockError).toHaveBeenCalledTimes(1);
    expect(tg.sendMessage).toHaveBeenCalledTimes(2);
    expect(typeof log.messageId).toBe('number');
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

  it('still backs off when one chunk sanitized and another hit a transient error', async () => {
    // repaired/transient are per-chunk: a pure-sanitize chunk needs no wait,
    // but a co-flushed transient chunk still does, so the flush must sleep
    const tg = makeTg();
    spyMock(console, 'error');
    setRetryPassDelayMs(50);
    const sleep = spyOn(Bun, 'sleep');
    // two chunks: the second append overflows MAX_LENGTH into a new message
    const log = new LogMessage(tg, dest);
    log.append('a'.repeat(4090)); // chunk 0
    log.append('b'.repeat(20)); // chunk 1
    // chunk 0's send parse-rejects (sanitize), chunk 1's send 429s (transient)
    tg.sendMessage
      .mockRejectedValueOnce(parseRejection())
      .mockRejectedValueOnce(telegramError(429, 'Too Many Requests'));
    await log.flush();
    // the transient chunk earned its backoff: a nonzero inter-pass sleep fired
    expect(sleep).toHaveBeenCalledWith(50);
    sleep.mockRestore();
  });

  it('does not back off when a flush only sanitized (no transient error)', async () => {
    // a pure-sanitize pass is immediately sendable, so the retry pass must not
    // pay the inter-pass wait
    const tg = makeTg();
    spyMock(console, 'error');
    setRetryPassDelayMs(50);
    const sleep = spyOn(Bun, 'sleep');
    const log = new LogMessage(tg, dest, 'foo');
    await log.flush(); // sends 'foo'
    tg.editMessageText.mockRejectedValueOnce(parseRejection());
    log.append('<code>broken');
    await log.flush(); // rejected, sanitized in place, redelivered same flush
    expect(sleep).not.toHaveBeenCalledWith(50);
    sleep.mockRestore();
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

describe('logFor', () => {
  it('gives groups a silent NoLog and private chats a real LogMessage', () => {
    // THE group-silence policy site: handlers.test exercises it only through
    // a mock that mirrors this mapping, so the real mapping pins here
    const tg = makeTg();
    expect(logFor(tg, 'group', dest)).toBeInstanceOf(NoLog);
    expect(logFor(tg, 'supergroup', dest)).toBeInstanceOf(NoLog);
    const priv = logFor(tg, 'private', dest);
    expect(priv).toBeInstanceOf(LogMessage);
    expect(priv).not.toBeInstanceOf(NoLog);
  });
});

describe('NoLog', () => {
  it('does nothing', async () => {
    const log = new NoLog();
    log.append('bar');
    await log.flush();
  });
});
