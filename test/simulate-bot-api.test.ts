import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  mock,
  spyOn,
} from 'bun:test';
import {
  GONE_REPLY_ID,
  MOCK_USER_ID,
  MockBotApi,
  REAL_ERRORS,
  withBotApi,
} from './simulate-bot-api';

beforeEach(() => jest.clearAllMocks());
afterAll(() => mock.restore());

describe('MockBotApi', () => {
  let api: MockBotApi;

  beforeEach(() => {
    api = new MockBotApi();
  });

  it('constructs with valid botToken and user/bot fields', () => {
    expect(api.botToken).toMatch(/^\d+:[a-zA-Z0-9]{32}$/);
    expect(typeof api['user'].id).toBe('number');
    expect(api['bot'].is_bot).toBe(true);
  });

  it('sendTextMessageToBot adds update and flushes', () => {
    const flushSpy = spyOn(api, 'flush');
    api.sendTextMessageToBot({ text: 'hi' });
    expect(api['updates'].length).toBe(1);
    expect(flushSpy).toHaveBeenCalled();
  });

  it('sendUpdateToBot adds update and flushes', () => {
    const flushSpy = spyOn(api, 'flush');
    api.sendUpdateToBot({ message: { text: 'yo' } as any });
    expect(api['updates'].length).toBe(1);
    expect(flushSpy).toHaveBeenCalled();
  });

  it('flush calls all watchers and clears them', () => {
    let called = 0;
    api['watchers'].push(() => called++);
    api['watchers'].push(() => called++);
    api.flush();
    expect(called).toBe(2);
    expect(api['watchers'].length).toBe(0);
  });

  it('handle getMe returns bot info', async () => {
    const resp = await api.call('getMe', {});
    expect(resp).toBeInstanceOf(Response);
    const json = await resp.json();
    expect(json.ok).toBe(true);
    expect(json.result.is_bot).toBe(true);
  });

  it('handle deleteWebhook returns ok', async () => {
    const resp = await api.call('deleteWebhook', {});
    const json = await resp.json();
    expect(json.ok).toBe(true);
    expect(json.description).toMatch(/Webhook/);
  });

  it('handle getUpdates returns updates', async () => {
    api.sendTextMessageToBot({ text: 'foo' });
    const resp = await api.call('getUpdates', {});
    const json = await resp.json();
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.result)).toBe(true);
    expect(json.result.length).toBe(1);
  });

  it('handle sendMessage stores and returns message', async () => {
    const resp = await api.call('sendMessage', {
      chat_id: api['user'].id,
      text: 'hello',
    });
    const json = await resp.json();
    expect(json.ok).toBe(true);
    expect(json.result.text).toBe('hello');
    expect(api.sentMessages.length).toBe(1);
  });

  it('handle sendMessage with wrong chat_id returns error', async () => {
    const resp = await api.call('sendMessage', { chat_id: 9999, text: 'fail' });
    const json = await resp.json();
    expect(json.ok).toBe(false);
    expect(json.description).toMatch(/chat not found/);
  });

  it('handle editMessageText edits message', async () => {
    // First, send a message
    await api.call('sendMessage', { chat_id: api['user'].id, text: 'old' });
    // Now, edit it
    const resp = await api.call('editMessageText', {
      chat_id: api['user'].id,
      message_id: 0,
      text: 'new',
    });
    const json = await resp.json();
    expect(json.ok).toBe(true);
    expect(json.result.text).toBe('new');
  });

  it('handle editMessageText with same text returns error', async () => {
    await api.call('sendMessage', { chat_id: api['user'].id, text: 'same' });
    const resp = await api.call('editMessageText', {
      chat_id: api['user'].id,
      message_id: 0,
      text: 'same',
    });
    const json = await resp.json();
    expect(json.ok).toBe(false);
    expect(json.description).toMatch(/not modified/);
  });

  it('handle editMessageText with wrong chat_id returns error', async () => {
    await api.call('sendMessage', { chat_id: api['user'].id, text: 'msg' });
    const resp = await api.call('editMessageText', {
      chat_id: 9999,
      message_id: 0,
      text: 'edit',
    });
    const json = await resp.json();
    expect(json.ok).toBe(false);
    expect(json.description).toMatch(/can't be edited/);
  });

  it('handle sendVideo returns error if file does not exist', async () => {
    const resp = await api.call('sendVideo', {
      chat_id: api['user'].id,
      video: Bun.pathToFileURL('/tmp/fake.mp4'),
      width: 1,
      height: 1,
      duration: 1,
    });
    const json = await resp.json();
    expect(json.ok).toBe(false);
    expect(json.description).toMatch(/file not found/);
  });

  it('handle sendVideo returns ok if file exists', async () => {
    //@ts-ignore
    spyOn(Bun, 'file').mockReturnValue({
      exists: mock().mockResolvedValue(true),
      size: 1,
    });
    const resp = await api.call('sendVideo', {
      chat_id: api['user'].id,
      video: Bun.pathToFileURL('/tmp/real.mp4'),
      width: 1,
      height: 1,
      duration: 1,
    });
    const json = await resp.json();
    expect(json.ok).toBe(true);
    expect(json.result.video.file_name).toBe('/tmp/real.mp4');
  });

  it('handle sendVideo returns error if file is empty', async () => {
    //@ts-ignore
    spyOn(Bun, 'file').mockReturnValue({
      exists: mock().mockResolvedValue(true),
      size: 0,
    });
    const resp = await api.call('sendVideo', {
      chat_id: api['user'].id,
      video: Bun.pathToFileURL('/tmp/empty.mp4'),
      width: 1,
      height: 1,
      duration: 1,
    });
    const json = await resp.json();
    expect(json.ok).toBe(false);
    expect(json.description).toMatch(/file is empty/);
  });

  it('rejects an unknown file_id with the real server wording', async () => {
    const resp = await api.call('sendVideo', {
      chat_id: MOCK_USER_ID,
      video: 'AgACnever-issued',
    });
    const json = await resp.json();
    expect(json.ok).toBe(false);
    expect(json.description).toMatch(/wrong remote file identifier/);
  });

  it('rejects a reply to the deleted-target sentinel with the real wording', async () => {
    const resp = await api.call('sendMessage', {
      chat_id: MOCK_USER_ID,
      text: 'x',
      reply_parameters: { message_id: GONE_REPLY_ID },
    });
    const json = await resp.json();
    expect(json.ok).toBe(false);
    expect(json.description).toBe(
      'Bad Request: message to be replied not found',
    );
  });

  it('rejects unclosed HTML with the real parse-entities wording', async () => {
    const resp = await api.call('sendMessage', {
      chat_id: MOCK_USER_ID,
      text: '<code>unclosed',
      parse_mode: 'HTML',
    });
    const json = await resp.json();
    expect(json.ok).toBe(false);
    expect(json.description).toMatch(
      /can't parse entities: Can't find end tag corresponding to start tag "code"/,
    );
  });

  it('rejects an early unclosed tag even when a later pair balances', async () => {
    // tally opens vs closes: a last-occurrence lookahead would let the later
    // <b>ok</b> pair mask the first, still-open <b> (which the real parser
    // rejects). Log chunks are cumulative appended lines, exactly this shape.
    const resp = await api.call('sendMessage', {
      chat_id: MOCK_USER_ID,
      text: '<b>broken\n<b>ok</b>',
      parse_mode: 'HTML',
    });
    const json = await resp.json();
    expect(json.ok).toBe(false);
    expect(json.description).toMatch(/Can't find end tag/);
  });

  it('fails an unmocked fetch loudly instead of hitting the network', async () => {
    await expect(fetch('https://nope.example/x')).rejects.toThrow(
      'unmocked fetch in test',
    );
  });

  it('failNext answers the next calls of a method with the given error', async () => {
    const limited = REAL_ERRORS.sendMessage_rate_limited;
    api.failNext(limited, 2);
    const msg = { chat_id: MOCK_USER_ID, text: 'x' };
    for (let i = 0; i < 2; i++) {
      const resp = await api.call('sendMessage', msg);
      expect(resp.status).toBe(limited.status);
      expect(await resp.json()).toEqual(limited.body);
    }
    expect((await (await api.call('sendMessage', msg)).json()).ok).toBe(true);
    expect(api.sentMessages).toHaveLength(1);
  });

  it('logs every call, failed ones included, except the polling', async () => {
    api.failNext(REAL_ERRORS.sendMessage_rate_limited);
    await api.call('sendMessage', { chat_id: MOCK_USER_ID, text: 'x' });
    await api.call('getUpdates', {});
    expect(api.requests).toEqual([
      { method: 'sendMessage', data: { chat_id: MOCK_USER_ID, text: 'x' } },
    ]);
  });

  it('records inline query answers', async () => {
    const resp = await api.call('answerInlineQuery', {
      inline_query_id: '7',
      results: [],
    });
    expect((await resp.json()).result).toBe(true);
    expect(api.answeredInlineQueries).toEqual([
      { inline_query_id: '7', results: [] },
    ]);
  });

  it('accepts sends to a chat added with addChat', async () => {
    api.addChat({ id: -42, type: 'group', title: 'g' });
    const resp = await api.call('sendMessage', { chat_id: -42, text: 'hi' });
    const json = await resp.json();
    expect(json.result.chat).toEqual({ id: -42, type: 'group', title: 'g' });
  });

  it('rejects a parked long poll with an AbortError when its signal aborts', async () => {
    const controller = new AbortController();
    const parked = api.call('getUpdates', { timeout: 50 }, controller.signal);
    await Bun.sleep(10);
    controller.abort();
    await expect(parked).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
      api.call('getUpdates', { timeout: 50 }, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects an already-aborted poll even when updates are waiting', async () => {
    api.sendTextMessageToBot({ text: 'foo' });
    const controller = new AbortController();
    controller.abort();
    await expect(
      api.call('getUpdates', {}, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('detaches its abort listener once a parked poll is answered', async () => {
    const signal = new AbortController().signal;
    const removed = spyOn(signal, 'removeEventListener');
    const parked = api.call('getUpdates', { timeout: 50 }, signal);
    await Bun.sleep(10);
    api.sendTextMessageToBot({ text: 'foo' });
    expect(((await (await parked).json()) as any).result).toHaveLength(1);
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('tracks the highest getUpdates offset the bot has asked for', async () => {
    await api.call('getUpdates', { offset: 3 });
    await api.call('getUpdates', { offset: 1 });
    expect(api.handledOffset).toBe(3);
  });

  it('builds a callback query around the bot message that was clicked', async () => {
    const group = { id: -42, type: 'group', title: 'g' };
    api.addChat(group);
    const reply_markup = {
      inline_keyboard: [[{ text: 'Yes', callback_data: 'dl:x' }]],
    };
    await api.call('sendMessage', { chat_id: -42, text: 'Sure?', reply_markup });
    const u = api.sendCallbackQueryToBot(0, 'dl:x') as any;
    expect(u.callback_query.message).toMatchObject({
      message_id: 0,
      chat: group,
      text: 'Sure?',
      reply_markup,
    });
  });

  it('handle unknown command throws', () =>
    expect(api.call('unknownCommand', {})).rejects.toThrow(
      /not yet implemented/,
    ));
});

describe('withBotApi', () => {
  it('runs callback and cleans up', async () => {
    let ran = false;
    await withBotApi(async (api) => {
      ran = true;
      expect(api).toBeInstanceOf(MockBotApi);
    });
    expect(ran).toBe(true);
  });
});
