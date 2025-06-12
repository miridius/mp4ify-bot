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
import { apiRoot } from '../src/consts';
import { MockBotApi, withBotApi } from './simulate-bot-api';

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

  it('handle getMe returns bot info', () => {
    const url = new URL(`${apiRoot}/bot${api.botToken}/getMe`);
    const resp = api.handle(url, {
      method: 'POST',
      body: '{}',
    }) as Response;
    expect(resp).toBeInstanceOf(Response);
    return resp.json().then((json) => {
      expect(json.ok).toBe(true);
      expect(json.result.is_bot).toBe(true);
    });
  });

  it('handle deleteWebhook returns ok', () => {
    const url = new URL(`${apiRoot}/bot${api.botToken}/deleteWebhook`);
    const resp = api.handle(url, { method: 'POST', body: '{}' }) as Response;
    return resp.json().then((json) => {
      expect(json.ok).toBe(true);
      expect(json.description).toMatch(/Webhook/);
    });
  });

  it('handle getUpdates returns updates', async () => {
    api.sendTextMessageToBot({ text: 'foo' });
    const url = new URL(`${apiRoot}/bot${api.botToken}/getUpdates`);
    const resp = (await api.handle(url, {
      method: 'POST',
      body: '{}',
    })) as Response;
    const json = await resp.json();
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.result)).toBe(true);
    expect(json.result.length).toBe(1);
  });

  it('handle sendMessage stores and returns message', () => {
    const url = new URL(`${apiRoot}/bot${api.botToken}/sendMessage`);
    const body = JSON.stringify({ chat_id: api['user'].id, text: 'hello' });
    const resp = api.handle(url, { method: 'POST', body }) as Response;
    return resp.json().then((json) => {
      expect(json.ok).toBe(true);
      expect(json.result.text).toBe('hello');
      expect(api.sentMessages.length).toBe(1);
    });
  });

  it('handle sendMessage with wrong chat_id returns error', () => {
    const url = new URL(`${apiRoot}/bot${api.botToken}/sendMessage`);
    const body = JSON.stringify({ chat_id: 9999, text: 'fail' });
    const resp = api.handle(url, { method: 'POST', body }) as Response;
    return resp.json().then((json) => {
      expect(json.ok).toBe(false);
      expect(json.description).toMatch(/chat not found/);
    });
  });

  it('handle editMessageText edits message', () => {
    // First, send a message
    api.handle(new URL(`${apiRoot}/bot${api.botToken}/sendMessage`), {
      method: 'POST',
      body: JSON.stringify({ chat_id: api['user'].id, text: 'old' }),
    });
    // Now, edit it
    const url = new URL(`${apiRoot}/bot${api.botToken}/editMessageText`);
    const body = JSON.stringify({
      chat_id: api['user'].id,
      message_id: 0,
      text: 'new',
    });
    const resp = api.handle(url, { method: 'POST', body }) as Response;
    return resp.json().then((json) => {
      expect(json.ok).toBe(true);
      expect(json.result.text).toBe('new');
    });
  });

  it('handle editMessageText with same text returns error', () => {
    api.handle(new URL(`${apiRoot}/bot${api.botToken}/sendMessage`), {
      method: 'POST',
      body: JSON.stringify({ chat_id: api['user'].id, text: 'same' }),
    });
    const url = new URL(`${apiRoot}/bot${api.botToken}/editMessageText`);
    const body = JSON.stringify({
      chat_id: api['user'].id,
      message_id: 0,
      text: 'same',
    });
    const resp = api.handle(url, { method: 'POST', body }) as Response;
    return resp.json().then((json) => {
      expect(json.ok).toBe(false);
      expect(json.description).toMatch(/same/);
    });
  });

  it('handle editMessageText with wrong chat_id returns error', () => {
    api.handle(new URL(`${apiRoot}/bot${api.botToken}/sendMessage`), {
      method: 'POST',
      body: JSON.stringify({ chat_id: api['user'].id, text: 'msg' }),
    });
    const url = new URL(`${apiRoot}/bot${api.botToken}/editMessageText`);
    const body = JSON.stringify({ chat_id: 9999, message_id: 0, text: 'edit' });
    const resp = api.handle(url, { method: 'POST', body }) as Response;
    return resp.json().then((json) => {
      expect(json.ok).toBe(false);
      expect(json.description).toMatch(/can't be edited/);
    });
  });

  it('handle sendVideo returns error if file does not exist', async () => {
    const url = new URL(`${apiRoot}/bot${api.botToken}/sendVideo`);
    const body = JSON.stringify({
      chat_id: api['user'].id,
      video: Bun.pathToFileURL('/tmp/fake.mp4'),
      width: 1,
      height: 1,
      duration: 1,
    });
    const resp = (await api.handle(url, { method: 'POST', body })) as Response;
    const json = await resp.json();
    expect(json.ok).toBe(false);
    expect(json.description).toMatch(/file not found/);
  });

  it('handle sendVideo returns ok if file exists', async () => {
    //@ts-ignore
    spyOn(Bun, 'file').mockReturnValue({
      exists: mock().mockResolvedValue(true),
    });
    const url = new URL(`${apiRoot}/bot${api.botToken}/sendVideo`);
    const body = JSON.stringify({
      chat_id: api['user'].id,
      video: Bun.pathToFileURL('/tmp/real.mp4'),
      width: 1,
      height: 1,
      duration: 1,
    });
    const resp = (await api.handle(url, { method: 'POST', body })) as Response;
    const json = await resp.json();
    expect(json.ok).toBe(true);
    expect(json.result.video.file_name).toBe('/tmp/real.mp4');
  });

  it('handle unknown command throws', () => {
    const url = new URL(`${apiRoot}/bot${api.botToken}/unknownCommand`);
    expect(() => api.handle(url, { method: 'POST', body: '{}' })).toThrow(
      /not yet implemented/,
    );
  });
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
