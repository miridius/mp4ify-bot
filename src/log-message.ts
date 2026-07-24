import type { Telegram } from 'telegraf';

const MAX_LENGTH = 4096;
const CONTINUED = '<i>...continued...</i>\n\n';
const TEXT_MSG_OPTS = {
  parse_mode: 'HTML' as const,
  link_preview_options: { is_disabled: true },
  disable_notification: true,
};
const DEBOUNCE_MS = 150;

// inter-pass backoff before a doFlush retry pass (see the loop below)
let retryPassDelayMs = 500;
// test-only: shrink it to 0 so suites don't sleep real seconds across passes
// (mirrors setRetryBaseMs in job-queue)
export const setRetryPassDelayMs = (ms: number) => {
  retryPassDelayMs = ms;
};

export type LogDest = {
  chatId: number;
  replyTo: number;
  // reuse (edit) an existing message instead of sending a new reply, so a
  // job's retries update one message rather than spawning a new thread each
  editMessageId?: number;
  // that message's current content: new appends CONTINUE it, so a retry adds
  // its lines below the prior attempt's instead of wiping the message
  editText?: string;
};

// the few fields of a sent message we actually use: avoids casting a partial
// to telegraf's full Message.TextMessage
type LogMsg = { chat: { id: number }; message_id: number; text: string };

// One definition of "tag" for the whole class: the echo compare-base and the
// parse-reject sanitize must agree on what gets stripped.
const stripTags = (s: string) => s.replaceAll(/<[^>]+>/g, '');

// Where to cut an oversize line for the hard split: at most `from + max`,
// backed off so the cut never lands inside an HTML tag (a stranded partial
// tag like `</co` is exactly what stripTags can NOT later strip, so the
// parse-reject recovery couldn't heal it) nor between surrogate halves (a
// lone surrogate is itself a parse rejection). The one oversize producer is
// verbose stderr wrapped in <code>, so mid-tag cuts would otherwise be the
// COMMON case, turning every split into a guaranteed failed send.
const splitPoint = (line: string, from: number, max: number): number => {
  let end = Math.min(from + max, line.length);
  if (end >= line.length) return end;
  const code = line.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--; // high surrogate: keep the pair
  const open = line.lastIndexOf('<', end - 1);
  // `open > from` also bounds the pathological case (a "tag" spanning the
  // whole slice never backs off, so the cut proceeds mid-tag and costs one
  // sanitize round-trip instead of an infinite loop). close === -1 covers a
  // lone '<' with no closing '>' before the boundary: indexOf returns -1,
  // which would slip past a `>= end` test and cut inside the stranded tag.
  const close = line.indexOf('>', open);
  if (open > from && (close === -1 || close >= end)) end = open;
  return end;
};
const errDesc = (e: any) => String(e?.response?.description ?? e?.message ?? e);

// Writes log output to a chat by editing a single message across updates.
// Callers decide where it's used: url jobs log progress only in private chats
// (a NoLog in groups), confirmed jobs use it for failure reports in any chat.
export class LogMessage {
  private texts: string[] = [];
  private messages: (LogMsg | undefined)[] = [];
  private dest?: LogDest;
  private timer?: Timer;
  private flushing = Promise.resolve(); // tail of the serialized flush chain
  private sawTransient = false;

  constructor(
    private telegram?: Telegram,
    dest?: LogDest,
    initialText?: string,
  ) {
    if (telegram && dest) {
      this.dest = dest;
      // seed a stub message so the first flush EDITS the prior reply (a retry
      // continuing the same thread) instead of sending a fresh one; the seed
      // is tag-stripped to match setMessageText's echo compare-base, so an
      // unchanged flush doesn't fire a spurious edit.
      if (dest.editMessageId != null) {
        const prior = dest.editText ?? '';
        this.messages = [
          {
            chat: { id: dest.chatId },
            message_id: dest.editMessageId,
            text: stripTags(prior),
          },
        ];
        if (prior) this.texts = [prior];
      }
    }
    if (initialText) this.append(initialText);
  }

  // The live message a retry should continue: id and content of the LAST
  // chunk; appends land there once a long log has split into several
  // messages. Both are undefined when nothing (or nothing since a failed
  // send) exists, so a retry posts fresh rather than editing a message that
  // isn't there.
  get messageId(): number | undefined {
    return this.messages[this.messages.length - 1]?.message_id;
  }

  get text(): string | undefined {
    return this.messages[this.messages.length - 1]
      ? this.texts[this.messages.length - 1]
      : undefined;
  }

  append(line: string) {
    console.debug(line);
    if (!this.dest) return;
    if (this.timer) clearTimeout(this.timer);
    // A single line longer than one message is hard-split: stored whole, its
    // chunk could never be sent (Telegram rejects oversize text, and unlike a
    // parse rejection no retry can shrink it), poisoning every later append
    // on that chunk. do/while: an empty append must still push its newline.
    const max = MAX_LENGTH - CONTINUED.length;
    let i = 0;
    do {
      const end = splitPoint(line, i, max);
      this.pushLine(line.slice(i, end));
      i = end;
    } while (i < line.length);
    this.timer = setTimeout(
      () => this.flush().catch((e) => console.error('Log flush failed:', e)),
      DEBOUNCE_MS,
    );
    // don't let a pending debounce hold Bun's loop during the shutdown drain:
    // bot.ts's non-unref'd hold interval keeps the loop alive until jobsIdle &&
    // inlineIdle, so all that unref can drop after that is a cosmetic trailing
    // progress edit (terminal states flush explicitly); mirrors job-queue's
    // retry timers
    this.timer.unref?.();
  }

  private pushLine(line: string) {
    if (this.texts.length === 0) {
      this.texts.push(line);
      return;
    }
    const newText = this.texts[this.texts.length - 1] + '\n' + line;
    if (newText.length > MAX_LENGTH) {
      this.texts.push(CONTINUED + line);
    } else {
      this.texts[this.texts.length - 1] = newText;
    }
  }

  async flush(): Promise<void> {
    if (!this.dest) return;
    // Serialize: a debounced auto-flush and an explicit flush() must not both
    // read this.messages then each send the still-unsent reply (double-post).
    // Chain each after the previous; doFlush never rejects (setMessageText
    // swallows its errors), so a failed flush can't poison the chain.
    const run = this.flushing.then(() => this.doFlush());
    this.flushing = run;
    await run;
  }

  private async doFlush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    // Up to three passes per flush: one round-trip can leave a chunk
    // undelivered (a failed send, a transient edit error, or a parse
    // rejection that sanitized the chunk in place), and the job's FINAL
    // flush has no later flush to pick it up; without the retry passes a
    // terminal failure report would silently die on one bad round-trip.
    // Bounded: a chunk that still won't deliver after three tries (e.g. the
    // user blocked the bot) is given up on, matching the job's own attempt
    // bounds.
    for (let pass = 0; pass < 3; pass++) {
      // space out transient retries; a sanitize repair is immediately sendable
      // so needs no wait
      const sawTransient = this.sawTransient;
      this.sawTransient = false;
      if (pass && sawTransient) await Bun.sleep(retryPassDelayMs * pass);
      // Sequential, not Promise.all: on a first flush with 2+ chunks a raced
      // concurrent send has no cross-request ordering guarantee, so the
      // '...continued...' chunk could land ABOVE its head. Delivering in order
      // pins it. The delivered() early-out keeps the common case cheap (all but
      // the last chunk are already sent, so only the tail pays a round-trip).
      // No lock around `texts`: reads are synchronous, so a racing append only
      // grows it, and the new content flushes next round.
      const next: (LogMsg | undefined)[] = [];
      for (let i = 0; i < this.texts.length; i++) {
        next[i] = this.delivered(i)
          ? this.messages[i]
          : await this.setMessageText(this.texts[i]!, this.messages[i], i);
      }
      this.messages = next;
      if (this.texts.every((_, i) => this.delivered(i))) return;
    }
  }

  // whether chunk i's current content is what the chat actually shows
  private delivered(index: number): boolean {
    const m = this.messages[index];
    return !!m && m.text === this.html(this.texts[index]!, index);
  }

  // stripTags of a chunk, memoized per index: doFlush re-visits every chunk
  // on every flush, but frozen chunks (all but the last) never change, and
  // re-stripping each of them per flush is quadratic over a long verbose log
  private stripCache: ({ raw: string; html: string } | undefined)[] = [];
  private html(text: string, index: number): string {
    const cached = this.stripCache[index];
    if (cached?.raw === text) return cached.html;
    const html = stripTags(text);
    this.stripCache[index] = { raw: text, html };
    return html;
  }

  // A parse rejection is deterministic: retrying identical broken HTML can
  // never succeed, and would doom every later line on the chunk, including
  // the terminal failure report. Replace the LIVE chunk with its tag-stripped
  // form (never a caller's snapshot: appends that raced the failed call must
  // survive; they flush next round, stripped) so future flushes build on
  // parseable text. Returns whether the error was a parse rejection.
  private sanitizeIfParseReject(desc: string, index: number): boolean {
    if (!/can't parse entities/i.test(desc)) return false;
    this.texts[index] = stripTags(this.texts[index]!);
    return true;
  }

  private async setMessageText(
    text: string,
    message: LogMsg | undefined,
    index: number,
  ): Promise<LogMsg | undefined> {
    // Telegram's echoed text has HTML tags stripped and entities decoded
    // (&amp; -> &), so compare against our own stripped form, not what it returns.
    const html = this.html(text, index);
    if (!message) {
      try {
        const sent = await this.telegram!.sendMessage(this.dest!.chatId, text, {
          reply_parameters: { message_id: this.dest!.replyTo },
          ...TEXT_MSG_OPTS,
        });
        return { chat: { id: sent.chat.id }, message_id: sent.message_id, text: html };
      } catch (e: any) {
        console.error('Failed to send log message', text, e);
        // a non-parse-reject send failure is transient (rate limit / network):
        // the retry pass backs off, unlike a sanitized-in-place parse reject
        if (!this.sanitizeIfParseReject(errDesc(e), index)) this.sawTransient = true;
        return undefined; // the next pass (or flush) retries
      }
    }
    if (message.text === html) return message;
    try {
      const edited = await this.telegram!.editMessageText(
        message.chat.id,
        message.message_id,
        undefined,
        text,
        TEXT_MSG_OPTS,
      );
      const m = edited === true ? message : edited;
      return { chat: { id: m.chat.id }, message_id: m.message_id, text: html };
    } catch (e: any) {
      console.error('Failed to edit message', text, e);
      const desc = errDesc(e);
      // benign "not modified" → mark as sent so we don't loop re-editing
      if (/not modified/i.test(desc)) {
        message.text = html;
        return message;
      }
      if (this.sanitizeIfParseReject(desc, index)) {
        // NOT marked sent: the chunk now holds its sanitized (parseable)
        // form, and the next doFlush pass delivers it; marking sent here
        // would strand the chat on the pre-append content forever
        return message;
      }
      // transient: keep the message so the next pass (or flush) retries the
      // edit, instead of posting a duplicate reply
      const code = e?.response?.error_code as number | undefined;
      if (
        code === 429 ||
        (code != null && code >= 500) ||
        /too many requests|fetch failed|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(desc)
      ) {
        this.sawTransient = true;
        return message;
      }
      // the message is gone/uneditable (e.g. the user deleted it, or it's too
      // old): send a fresh reply so the update isn't lost
      return this.setMessageText(text, undefined, index);
    }
  }
}

export class NoLog extends LogMessage {
  // explicit super() so bun's coverage counts LogMessage's constructor as run
  constructor() {
    super();
  }
  append(_line: string) {}
  async flush() {}
}

// url-job progress logs to private chats only: a group would be spammed for
// every link posted. Terminal failure reports come from their own call sites.
export const logFor = (
  telegram: Telegram,
  chatType: string,
  dest: LogDest,
): LogMessage =>
  chatType === 'private' ? new LogMessage(telegram, dest) : new NoLog();
