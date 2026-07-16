// Workaround for Bun test runner bug where process.stderr.fd becomes undefined,
// which crashes the `debug` module used by telegraf
if (process.stderr && process.stderr.fd === undefined) {
  (process.stderr as any).fd = 2;
}

import { faker } from '@faker-js/faker';
import { mock, spyOn } from 'bun:test';
import type { Message, Update } from 'telegraf/types';
import { apiRoot } from '../src/consts';

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

const errResp = (description: string) =>
  new Response(JSON.stringify({ ok: false, error_code: 400, description }), {
    status: 400,
  });

// the id of the simulated private chat / user, so a test that pre-seeds a job
// (before the api exists) can address messages to the right chat
export const MOCK_USER_ID = 1337;

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
  private date = 0;
  private pathPrefix: string;
  private updates: Update[] = [];
  private watchers: Array<() => void> = [];
  public botToken: string;

  constructor() {
    this.botToken = `${this.bot.id}:${faker.string.alphanumeric(32)}`;
    this.pathPrefix = `/bot${this.botToken}/`;
    console.debug('simulating bot api with token:', this.botToken);
  }

  sendUpdateToBot(partialUpdate: Omit<Update, 'update_id'>) {
    const update = {
      update_id: this.updates.length,
      ...partialUpdate,
    } as Update;
    this.updates.push(update);
    this.flush();
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
    const message = {
      message_id: this.updates.length,
      from: { ...this.user, is_bot: false, language_code: 'en' },
      chat,
      date: this.date++,
      ...partialMsg,
    } as Message.TextMessage;
    this.sendUpdateToBot({ message });
  }

  sendEditedMessageToBot(
    partialMsg: Omit<
      Message.TextMessage,
      'message_id' | 'from' | 'chat' | 'date'
    > & { message_id: number },
  ) {
    const message = {
      from: { ...this.user, is_bot: false, language_code: 'en' },
      chat: { ...this.user, type: 'private' },
      date: this.date++,
      edit_date: this.date++,
      ...partialMsg,
    } as Message.TextMessage;
    this.sendUpdateToBot({ edited_message: message });
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
      switch (command) {
        case 'getMe':
          return this.getMe(data);
        case 'deleteWebhook':
          return this.deleteWebhook(data);
        case 'getUpdates':
          return this.getUpdates(data);
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

  private async getUpdates({
    timeout = 0,
    offset = 0,
    limit = 100,
  }: {
    timeout?: number;
    offset?: number;
    limit?: number;
    allowed_updates?: any[];
  }): Promise<Response> {
    const updates =
      offset == 0 && this.updates.length <= limit
        ? this.updates
        : this.updates.slice(offset, offset + limit);
    if (updates.length || !timeout) {
      return okResp(updates);
    } else {
      // wait for either timeout or for there to be a new update
      await Promise.race([
        new Promise((resolve) => this.watchers.push(() => resolve(null))),
        Bun.sleep(timeout * 1000),
      ]);
      // return whatever updates there now are (if any)
      return this.getUpdates({ timeout: 0, offset, limit });
    }
  }

  private messageResponse(
    message: { text: string; [key: string]: any },
    message_id: number,
  ) {
    return okResp({
      ...message,
      message_id,
      from: this.bot,
      chat: { ...this.user, type: 'private' },
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
    if (data.chat_id !== this.user.id) {
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
      : { ...this.user, is_bot: false, language_code: 'en' };
    this.sendUpdateToBot({
      callback_query: {
        id: String(this.date++),
        from,
        message: {
          message_id: messageId,
          from: this.bot,
          chat: { ...this.user, type: 'private' },
          date: this.date++,
          text: 'Download this video?',
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
    if (chat_id !== this.user.id) {
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
      chat: { ...this.user, type: 'private' },
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

export type TestFn = (api: MockBotApi) => void | Promise<void>;

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
  let testError: unknown;
  let threw = false;
  let drained = true;
  try {
    // NOTE: it's very important that the tests do not import the bot until
    // after the mocks are set up, else it doesn't use the mocked fetch.
    // Also stub the yt-dlp self-update so starting the bot doesn't spawn it.
    const downloadVideo = await import('../src/download-video');
    spyOn(downloadVideo, 'updateYtdlp').mockImplementation(async () => {});
    const { start } = await import('../src/bot');
    const bot = await start(api.botToken);
    try {
      await fn(api);
    } finally {
      bot.stop('test finished');
      api.flush();
      await Bun.sleep(100);
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
    const { waitUntil } = await import('./test-utils');
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
};
