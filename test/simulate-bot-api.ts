// Workaround for Bun test runner bug where process.stderr.fd becomes undefined,
// which crashes the `debug` module used by telegraf
if (process.stderr && process.stderr.fd === undefined) {
  (process.stderr as any).fd = 2;
}

import { faker } from '@faker-js/faker';
import { mock, spyOn } from 'bun:test';
import type { Telegraf } from 'telegraf';
import type { Message, Update } from 'telegraf/types';
import { apiRoot, INLINE_CACHE_CHAT_ID } from '../src/consts';
import errorReplies from './fixtures/real-error-replies.json';
import payloads from './fixtures/real-payloads.json';
import sendChats from './fixtures/real-send-chats.json';

export const REAL_ERRORS = errorReplies.replies;
type CapturedReply = { method: string; status: number; body: object };

// TODO: what if we use real bot token and let it send real messages, and we
// just record them & their responses? (could even re-use them?)
// we should probably consolidate final state of edited messages
// The only part we intercept is where it asks for updates.

// matches the `.{format_id}.` filename segment yt-dlp produces (plain or
// URL-encoded `]` before it). Shared by the e2e snapshot scrubber and the
// mock's file_id hashing so the two can't drift apart.
export const FORMAT_ID_RE = /(\]|%5D)\.[\w+-]+(\.mp4)/g;

const okResp = (result: any, description?: string) =>
  new Response(
    JSON.stringify({ ok: true, result, ...(description && { description }) }),
  );

export const errResp = (description: string, error_code = 400) =>
  new Response(JSON.stringify({ ok: false, error_code, description }), {
    status: error_code,
  });

// the id of the simulated private chat / user, so a test that pre-seeds a job
// (before the api exists) can address messages to the right chat
export const MOCK_USER_ID = 1337;
export const MOCK_GROUP_CHAT = payloads.payloads.group_plain_text.message.chat;

export class MockBotApi {
  private user = {
    id: MOCK_USER_ID,
    first_name: faker.person.firstName(),
    last_name: faker.person.lastName(),
    username: faker.internet.username(),
  };
  private bot = {
    id: faker.number.int({ min: 1000, max: 1e6 }),
    is_bot: true,
    first_name: faker.person.firstName(),
    username: faker.internet.username(),
  };
  public sentMessages: {
    chat_id: number;
    text?: string;
    video?: string;
    edit_date?: number;
    reply_markup?: any;
  }[] = [];
  public answeredCallbacks: { callback_query_id: string; text?: string }[] = [];
  public answeredInlineQueries: { inline_query_id: string; results: any[] }[] =
    [];
  public requests: { method: string; data: any }[] = [];
  // telegraf requests the next batch only after handling the previous one, so
  // an update is fully handled once a getUpdates offset has passed its id
  public handledOffset = 0;
  private faults = new Map<
    string,
    { reply: CapturedReply; remaining: number }
  >();
  private date = 0;
  // chats the bot may send to, mapped to the chat object the real server echoes
  // back on a send; an unknown chat_id gets its "chat not found"
  private knownChats = new Map<
    number,
    { id: number; type: string; [k: string]: any }
  >([
    [MOCK_USER_ID, { ...this.user, type: 'private' }],
    [MOCK_GROUP_CHAT.id, MOCK_GROUP_CHAT],
    [INLINE_CACHE_CHAT_ID, sendChats.chats.inline_cache_group],
  ]);
  private pathPrefix: string;
  private updates: Update[] = [];
  private watchers: Array<() => void> = [];
  public botToken: string;

  constructor() {
    this.botToken = `${this.bot.id}:${faker.string.alphanumeric(32)}`;
    this.pathPrefix = `/bot${this.botToken}/`;
    console.debug('simulating bot api with token:', this.botToken);
  }

  // updates pushed back to back reach the bot in one getUpdates batch, whose
  // updates telegraf handles concurrently
  sendUpdateToBot(partialUpdate: Omit<Update, 'update_id'>) {
    const update = {
      update_id: this.updates.length,
      ...partialUpdate,
    } as Update;
    this.updates.push(update);
    this.flush();
    return update;
  }

  addChat(chat: { id: number; type: string; [k: string]: any }) {
    this.knownChats.set(chat.id, chat);
  }

  async call(
    method: string,
    data: object,
    signal?: AbortSignal,
  ): Promise<Response> {
    const resp = this.handle(new URL(`${apiRoot}${this.pathPrefix}${method}`), {
      method: 'POST',
      body: JSON.stringify(data),
      signal,
    });
    if (!resp) throw new Error(`the mock did not route ${method}`);
    return resp;
  }

  private fromUser() {
    return { ...this.user, is_bot: false, language_code: 'en' };
  }

  failNext(reply: CapturedReply, times = 1) {
    this.faults.set(reply.method, { reply, remaining: times });
  }

  flush() {
    for (const watcher of this.watchers) watcher();
    this.watchers.length = 0; // clear watchers
  }

  sendTextMessageToBot(
    partialMsg: Omit<
      Message.TextMessage,
      'message_id' | 'from' | 'chat' | 'date'
    >,
    chatOverride?: { id: number; title?: string; type: string },
  ) {
    const chat = chatOverride ?? { ...this.user, type: 'private' };
    if (chatOverride) this.addChat(chatOverride);
    const message = {
      message_id: this.updates.length,
      from: this.fromUser(),
      chat,
      date: this.date++,
      ...partialMsg,
    } as Message.TextMessage;
    return this.sendUpdateToBot({ message });
  }

  sendEditedMessageToBot(
    partialMsg: Omit<
      Message.TextMessage,
      'message_id' | 'from' | 'chat' | 'date'
    > & { message_id: number },
  ) {
    const message = {
      from: this.fromUser(),
      chat: { ...this.user, type: 'private' },
      date: this.date++,
      edit_date: this.date++,
      ...partialMsg,
    } as Message.TextMessage;
    return this.sendUpdateToBot({ edited_message: message });
  }

  sendInlineQueryToBot(query: string) {
    return this.sendUpdateToBot({
      inline_query: {
        id: String(this.date++),
        from: this.fromUser(),
        chat_type: 'sender',
        query,
        offset: '',
      },
    });
  }

  handle(url: URL, opts: RequestInit = {}) {
    const { origin, pathname } = url;
    const { method = 'GET', body } = opts;
    if (
      origin === apiRoot &&
      pathname.startsWith(this.pathPrefix) &&
      method === 'POST'
    ) {
      const command = pathname.slice(this.pathPrefix.length);
      const data = JSON.parse(body as string);
      console.debug('mocking:', command);
      if (command !== 'getUpdates') this.requests.push({ method: command, data });
      const fault = this.faults.get(command);
      if (fault && fault.remaining-- > 0) {
        return new Response(JSON.stringify(fault.reply.body), {
          status: fault.reply.status,
        });
      }
      switch (command) {
        case 'getMe':
          return this.getMe(data);
        case 'deleteWebhook':
          return this.deleteWebhook(data);
        case 'getUpdates':
          return this.getUpdates(data, opts.signal);
        case 'sendMessage':
          return this.sendMessage(data);
        case 'editMessageText':
          return this.editMessageText(data);
        case 'deleteMessage':
          return okResp(true);
        case 'sendVideo':
          return this.sendVideo(data);
        case 'answerCallbackQuery':
          return this.answerCallbackQuery(data);
        case 'answerInlineQuery':
          this.answeredInlineQueries.push(data);
          return okResp(true);
        default:
          throw new Error('not yet implemented: ' + command);
      }
    }
  }

  private getMe(_body: any) {
    return okResp({
      ...this.bot,
      can_join_groups: true,
      can_read_all_group_messages: true,
      supports_inline_queries: true,
      can_connect_to_business: false,
      has_main_web_app: false,
    });
  }

  private deleteWebhook(_body: any) {
    return okResp(true, 'Webhook is already deleted');
  }

  private async getUpdates(
    {
      timeout = 0,
      offset = 0,
      limit = 100,
    }: {
      timeout?: number;
      offset?: number;
      limit?: number;
      allowed_updates?: any[];
    },
    signal?: AbortSignal | null,
  ): Promise<Response> {
    if (signal?.aborted) throw signal.reason;
    this.handledOffset = Math.max(this.handledOffset, offset);
    if (!this.batch(offset, limit).length && timeout) {
      let wake = () => {};
      let onAbort = () => {};
      let timer: Timer | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          wake = resolve;
          this.watchers.push(wake);
          timer = setTimeout(resolve, timeout * 1000);
          onAbort = () => reject(signal?.reason);
          signal?.addEventListener('abort', onAbort, { once: true });
        });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.watchers = this.watchers.filter((w) => w !== wake);
      }
    }
    return okResp(this.batch(offset, limit));
  }

  private batch(offset: number, limit: number) {
    return offset == 0 && this.updates.length <= limit
      ? this.updates
      : this.updates.slice(offset, offset + limit);
  }

  private chatFor(id: number) {
    return this.knownChats.get(id);
  }

  private messageResponse(
    message: { text: string; chat_id: number; [key: string]: any },
    message_id: number,
  ) {
    return okResp({
      ...message,
      message_id,
      from: this.bot,
      chat: this.chatFor(message.chat_id),
      date: this.date++,
      text: message.text.replaceAll(/<[^>]+>/g, ''), // strip html tags
      entities: [], // not needed for mocking
    });
  }

  private sendMessage(data: {
    chat_id: number;
    text: string;
    reply_markup?: any;
    reply_parameters?: { message_id: number };
    parse_mode?: string;
  }) {
    if (!this.knownChats.has(data.chat_id)) {
      return errResp('Bad Request: chat not found');
    }
    const err = this.replyOrParseError(data);
    if (err) return err;
    if (!data.text) {
      throw new Error('Not yet implemented');
    }
    this.sentMessages.push({ ...data } as any);
    return this.messageResponse(data as any, this.sentMessages.length - 1);
  }

  private editMessageText({
    chat_id,
    message_id,
    text,
    parse_mode,
  }: {
    chat_id: number;
    message_id: number;
    text: string;
    parse_mode?: string;
  }) {
    const parseErr = this.replyOrParseError({ text, parse_mode });
    if (parseErr) return parseErr;
    const message = this.sentMessages[message_id];
    if (!message?.text || message.chat_id !== chat_id) {
      return errResp("Bad Request: message can't be edited");
    }
    if (message.text === text) {
      // real Telegram's wording: LogMessage's not-modified tolerance keys on it
      return errResp('Bad Request: message is not modified');
    }
    message.text = text;
    return this.messageResponse(
      { ...message, edit_date: this.date++ } as any,
      message_id,
    );
  }

  // Error wordings the handlers key on, verified against the real bot-api
  // server (2026-07-05): a reply to GONE_REPLY_ID simulates the target having
  // been deleted, and an unclosed <tag> in HTML parse_mode is rejected the way
  // the real parser rejects it.
  private replyOrParseError(data: {
    text?: string;
    parse_mode?: string;
    reply_parameters?: { message_id: number };
  }) {
    if (data.reply_parameters?.message_id === GONE_REPLY_ID) {
      return errResp('Bad Request: message to be replied not found');
    }
    if (data.parse_mode !== 'HTML' || !data.text) return undefined;
    // One ordered pass, per-tag depth counts: a close that outnumbers its
    // opens SO FAR is an unexpected end tag; anything left open at the end is
    // an unclosed start tag. (A count-only tally would pass '</b>x<b>', and a
    // lookahead would let two opens share one close; the real parser rejects
    // both, wordings verified live 2026-07-05.)
    const depth = new Map<string, number>();
    for (const m of data.text.matchAll(/<(\/?)(\w+)>/g)) {
      const [, slash, tag] = m as unknown as [string, string, string];
      const d = (depth.get(tag) ?? 0) + (slash ? -1 : 1);
      if (d < 0) {
        const offset = Buffer.byteLength(data.text.slice(0, m.index));
        return errResp(
          `Bad Request: can't parse entities: Unexpected end tag at byte offset ${offset}`,
        );
      }
      depth.set(tag, d);
    }
    const unclosed = [...depth.entries()].find(([, d]) => d > 0)?.[0];
    if (unclosed) {
      return errResp(
        `Bad Request: can't parse entities: Can't find end tag corresponding to start tag "${unclosed}"`,
      );
    }
    return undefined;
  }

  private answerCallbackQuery(data: {
    callback_query_id: string;
    text?: string;
  }) {
    this.answeredCallbacks.push(data);
    return okResp(true);
  }

  sendCallbackQueryToBot(
    messageId: number,
    data: string,
    userOverride?: { id: number },
  ) {
    const from = userOverride
      ? { ...userOverride, is_bot: false, first_name: 'Other' }
      : this.fromUser();
    const clicked = this.sentMessages[messageId];
    if (!clicked) throw new Error(`the bot sent no message ${messageId}`);
    return this.sendUpdateToBot({
      callback_query: {
        id: String(this.date++),
        from,
        message: {
          message_id: messageId,
          from: this.bot,
          chat: this.chatFor(clicked.chat_id),
          date: this.date++,
          text: clicked.text,
          ...(clicked.reply_markup && { reply_markup: clicked.reply_markup }),
        },
        chat_instance: String(this.user.id),
        data,
      },
    } as any);
  }

  fileIds = new Map<string, string>();
  private async sendVideo(data: {
    chat_id: number;
    caption?: string;
    video: string;
    width: number;
    height: number;
    duration: number;
    reply_parameters?: any;
  }) {
    const { chat_id, caption, video, reply_parameters, ...extra } = data;
    if (!this.knownChats.has(chat_id)) {
      return errResp('Bad Request: chat not found');
    }
    const err = this.replyOrParseError(data);
    if (err) return err;
    let file_name: string;
    let file_id: string;
    if (this.fileIds.has(video)) {
      file_name = this.fileIds.get(video)!;
      file_id = video;
    } else if (!video.startsWith('file:')) {
      // a file_id we never issued (e.g. cached before the server data reset);
      // wording captured from the real server
      return errResp(
        "Bad Request: wrong remote file identifier specified: can't unserialize it. Wrong last symbol",
      );
    } else {
      file_name = Bun.fileURLToPath(video);
      const file = Bun.file(file_name);
      if (!(await file.exists())) {
        return errResp(`Bad Request: file not found: ${file_name}`);
      }
      // the real bot-api rejects empty uploads; catches truncated downloads
      if (file.size === 0) {
        return errResp(`Bad Request: file is empty: ${file_name}`);
      }
      // hash a format-normalized name so the file_id (pinned in e2e
      // snapshots) stays stable when yt-dlp's format selection drifts
      file_id = Bun.hash(video.replaceAll(FORMAT_ID_RE, '$1$2')).toString(36);
      this.fileIds.set(file_id, file_name);
    }
    const message = {
      video: {
        ...extra,
        file_name,
        file_id,
        file_unique_id: faker.string.alphanumeric(32),
      },
      message_id: this.sentMessages.length,
      from: this.bot,
      chat: this.chatFor(chat_id),
      date: this.date++,
      reply_parameters,
      caption,
    } as Message.VideoMessage;
    this.sentMessages.push(data);
    return okResp(message);
  }
}

const mockBotApis = new Set<MockBotApi>();

const mockedFetch = async (url: URL, opts: RequestInit = {}) => {
  for (const mockBotApi of mockBotApis) {
    const ret = mockBotApi.handle(url, opts);
    if (ret) return ret;
  }
  throw new Error(
    'unexpected request to ' + url.href + ' with body: ' + opts.body,
  );
};

mock.module('node-fetch', () => ({ default: mockedFetch }));

// The GitHub latest-release pre-check in updateYtdlp is the bot's one direct
// globalThis.fetch (telegraf goes through node-fetch above); tests must never
// hit the real API. Suites steer the response via githubMock.
// reply target that the mock treats as deleted (see replyOrParseError)
export const GONE_REPLY_ID = 999999;

export const githubMock = {
  // the tag_name the mocked API reports; null → the call fails (HTTP 500)
  latestTag: 'TEST-LATEST' as string | null,
};
export const runtimeFetch = globalThis.fetch;
globalThis.fetch = (async (input: any) => {
  const href =
    typeof input === 'string' ? input : (input?.url ?? String(input));
  if (href.startsWith('https://api.github.com/')) {
    return githubMock.latestTag == null
      ? new Response('rate limited', { status: 500 })
      : Response.json({ tag_name: githubMock.latestTag });
  }
  // no silent passthrough: any other URL is an unmocked network call that
  // would flake tests (or leak requests), so fail it loudly instead
  throw new Error(`unmocked fetch in test: ${href}`);
}) as typeof fetch;

export type TestFn = (
  api: MockBotApi,
  bot: Telegraf,
) => void | Promise<void>;

export const withBotApi = async (fn: TestFn) => {
  const api = new MockBotApi();
  mockBotApis.add(api);
  // the bot exits the process on a fatal polling crash (so docker restarts
  // it in production); under bun test that would kill the whole test runner,
  // e.g. when a poll in flight during teardown hits "unexpected request"
  const exitSpy = spyOn(process, 'exit').mockImplementation(((
    code?: number,
  ) => {
    console.error(`suppressed process.exit(${code}) during tests`);
  }) as any);
  const { waitUntil } = await import('./test-utils');
  let testError: unknown;
  let threw = false;
  let drained = true;
  let pollingStopped = true;
  let exitedOnStop = false;
  try {
    // NOTE: it's very important that the tests do not import the bot until
    // after the mocks are set up, else it doesn't use the mocked fetch.
    const botModule = await import('../src/bot');
    const bot = await botModule.start(api.botToken);
    try {
      await fn(api, bot);
    } finally {
      const exitsBefore = exitSpy.mock.calls.length;
      bot.stop('test finished');
      let ended = false;
      void botModule.pollingEnded().then(() => (ended = true));
      pollingStopped = await waitUntil(() => ended, 10_000);
      exitedOnStop = exitSpy.mock.calls.length > exitsBefore;
    }
  } catch (e) {
    testError = e;
    threw = true;
  } finally {
    // Let any jobs the test left in flight or mid-retry finish against this
    // test's still-registered mock: otherwise they'd bleed into the next test.
    // Drain BEFORE stopping: a stopped queue won't run pending or backed-off
    // jobs, so waiting for idle after stopJobQueue could hang on work that was
    // progressing fine. A job that genuinely never drains is a hang / missing
    // await: caught by the timeout reported below.
    const { resetJobQueue, jobsIdle, stopJobQueue } = await import(
      '../src/job-queue'
    );
    drained = await waitUntil(jobsIdle, 10_000);
    stopJobQueue();
    mockBotApis.delete(api);
    exitSpy.mockRestore();
    resetJobQueue();
    // wipe the durable store so the next test starts from an empty DB
    (await import('../src/db')).resetDb();
  }
  if (threw) throw testError;
  // a job still running after the test is a hang or a missing await: fail
  // loudly instead of silently abandoning it (but never mask fn's own error)
  if (!drained) {
    throw new Error(
      'jobs did not drain within 10s after the test: a job hung or never completed',
    );
  }
  if (!pollingStopped) {
    throw new Error(
      'telegraf polling did not stop within 10s after the test: a later poll could steal the next test\'s updates',
    );
  }
  if (exitedOnStop) {
    throw new Error('stopping the bot exited the process as a polling crash');
  }
};
