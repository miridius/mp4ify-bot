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
import * as telegraf from 'telegraf';
import * as telegrafFilters from 'telegraf/filters';
import { start } from '../src/bot';
import { apiRoot } from '../src/consts';
import * as handlers from '../src/handlers';
import { spyMock } from './test-utils';

beforeEach(() => jest.clearAllMocks());
afterAll(() => mock.restore());

// Mock telegraf and telegraf/filters
class MockTelegraf {
  static instances: any[] = [];
  telegram = { options: { apiRoot: 'mocked' } };
  on = mock();
  launch = mock();
  stop = mock();
  use = mock();
  polling = false;
  constructor(token: string, opts: any) {
    MockTelegraf.instances.push(this);
    this.telegram.options = opts.telegram;
    setTimeout(() => (this.polling = true), 50);
  }
}
spyOn(telegraf, 'Telegraf').mockImplementation(
  ((...args: ConstructorParameters<typeof telegraf.Telegraf>) =>
    new MockTelegraf(...args)) as never,
);
spyOn(telegrafFilters, 'message').mockImplementation(
  //@ts-ignore
  (type: string) => `message:${type}`,
);
spyOn(telegrafFilters, 'editedMessage').mockImplementation(
  //@ts-ignore
  (type: string) => `editedMessage:${type}`,
);

// Mock ./handlers
const textMessageHandler = spyOn(
  handlers,
  'textMessageHandler',
).mockImplementation(mock());
const inlineQueryHandler = spyOn(
  handlers,
  'inlineQueryHandler',
).mockImplementation(mock());

// Mock Bun.sleep
const sleepSpy = spyOn(Bun, 'sleep');

// Mock process.once
const processOnce = spyMock(process, 'once');

describe('start', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (telegraf.Telegraf as any).instances = [];
    processOnce.mockReset();
  });

  it('constructs Telegraf with correct args and sets up handlers', async () => {
    const botToken = 'test-token';

    const bot = await start(botToken);

    expect(MockTelegraf.instances.length).toBe(1);
    const instance = MockTelegraf.instances[0];
    expect(instance.telegram.options).toEqual({ apiRoot });

    instance.on.mock.calls.find(
      ([filter]: [string]) => filter === 'message:text',
    )?.[1]('foo');
    expect(textMessageHandler).toHaveBeenCalledWith('foo');

    instance.on.mock.calls.find(
      ([filter]: [string]) => filter === 'editedMessage:text',
    )?.[1]('bar');
    expect(textMessageHandler).toHaveBeenCalledWith('bar');

    instance.on.mock.calls.find(
      ([filter]: [string]) => filter === 'inline_query',
    )?.[1]('baz');
    expect(inlineQueryHandler).toHaveBeenCalledWith('baz');

    expect(instance.use).toHaveBeenCalled();

    expect(instance.launch).toHaveBeenCalled();
    expect(processOnce).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(processOnce).toHaveBeenCalledWith('SIGTERM', expect.any(Function));

    processOnce.mock.calls.find(([signal]) => signal === 'SIGINT')?.[1]();
    expect(bot.stop).toHaveBeenCalledWith('SIGINT');

    processOnce.mock.calls.find(([signal]) => signal === 'SIGTERM')?.[1]();
    expect(bot.stop).toHaveBeenCalledWith('SIGTERM');

    expect(bot).toBe(instance);
  });

  it('waits for polling to be true before continuing', async () => {
    const bot = await start('test-token');
    expect((bot as any).polling).toBeTruthy();
    expect(sleepSpy).toHaveBeenCalledWith(100);
  });
});
