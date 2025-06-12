import { faker } from '@faker-js/faker';
import { mock } from 'bun:test';
import type { Message, Update } from 'telegraf/types';
import { apiRoot } from '../src/consts';

// TODO: what if we use real bot token and let it send real messages, and we
// just record them & their responses? (could even re-use them?)
// we should probably consolidate final state of edited messages
// The only part we intercept is where it asks for updates.

const okResp = (result: any, description?: string) =>
  new Response(
    JSON.stringify({ ok: true, result, ...(description && { description }) }),
  );

const errResp = (description: string) =>
  new Response(JSON.stringify({ ok: false, error_code: 400, description }), {
    status: 400,
  });

export class MockBotApi {
  private user = {
    id: 1337,
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
  }[] = [];
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
  ) {
    const message = {
      message_id: this.updates.length,
      from: { ...this.user, is_bot: false, language_code: 'en' },
      chat: { ...this.user, type: 'private' },
      date: this.date++,
      ...partialMsg,
    } as Message.TextMessage;
    this.sendUpdateToBot({
      [Math.random() < 0.5 ? 'message' : 'edited_message']: message,
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
        case 'sendVideo':
          return this.sendVideo(data);
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

  private sendMessage(data: { chat_id: number; text: string }) {
    if (data.chat_id !== this.user.id) {
      return errResp('Bad Request: chat not found');
    }
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
  }: {
    chat_id: number;
    message_id: number;
    text: string;
  }) {
    const message = this.sentMessages[message_id];
    if (!message?.text || message.chat_id !== chat_id) {
      return errResp("Bad Request: message can't be edited");
    }
    if (message.text === text) {
      return errResp('Bad Request: message text is the same');
    }
    message.text = text;
    return this.messageResponse(
      { ...message, edit_date: this.date++ } as any,
      message_id,
    );
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
    let file_name: string;
    let file_id: string;
    if (this.fileIds.has(video)) {
      file_name = this.fileIds.get(video)!;
      file_id = video;
    } else {
      file_name = Bun.fileURLToPath(video);
      if (!(await Bun.file(file_name).exists())) {
        return errResp(`Bad Request: file not found: ${file_name}`);
      }
      file_id = Bun.hash(video).toString(36);
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

export type TestFn = (api: MockBotApi) => void | Promise<void>;

export const withBotApi = async (fn: TestFn) => {
  const api = new MockBotApi();
  mockBotApis.add(api);
  try {
    // NOTE: it's very important that the tests do not import the bot until
    // after the mocks are set up, else it doesn't use the mocked fetch.
    const { start } = await import('../src/bot');
    const bot = await start(api.botToken);
    try {
      await fn(api);
    } finally {
      bot.stop('test finished');
      api.flush();
      await Bun.sleep(100);
    }
  } finally {
    mockBotApis.delete(api);
  }
};
