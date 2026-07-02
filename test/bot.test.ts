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
// import * as telegraf from 'telegraf';
// import * as telegrafFilters from 'telegraf/filters';
import { mkdir, rm, stat } from 'fs/promises';
import { Telegraf } from 'telegraf';
import type { Message, Update } from 'telegraf/types';
import { start, sweepLegacyStorage } from '../src/bot';
import { apiRoot } from '../src/consts';
import * as downloadVideo from '../src/download-video';
import { YTDLP_UPDATE_INTERVAL_MS } from '../src/download-video';
import * as handlers from '../src/handlers';
import * as blobStore from '../src/blob-store';
import * as jobQueue from '../src/job-queue';
import * as pendingDownloads from '../src/pending-downloads';
import { rowCount, seedInfoRow, spyMock } from './test-utils';

beforeEach(() => jest.clearAllMocks());
afterAll(() => mock.restore());

let launched = false;
spyOn(Telegraf.prototype, 'launch').mockImplementation(async function (
  ...args: any[]
) {
  await Bun.sleep(10);
  launched = true;
  (this as any).polling = {}; // telegraf assigns this when polling starts
  // like the real launch(): invoke onLaunch, then stay pending
  args.find((a) => typeof a === 'function')?.();
  return new Promise<never>(() => {});
});

// Mock ./handlers
const textMessageHandler = spyMock(handlers, 'textMessageHandler');
const inlineQueryHandler = spyMock(handlers, 'inlineQueryHandler');
const callbackQueryHandler = spyMock(handlers, 'callbackQueryHandler');

// Mock the yt-dlp self-update (and watch setInterval to check it's scheduled)
const updateYtdlp = spyMock(downloadVideo, 'updateYtdlp');
// mock the download abort: the real one poisons module state (shuttingDown)
// for every suite that runs after this file's signal-handler invocations
const abortDownloads = spyMock(downloadVideo, 'abortDownloads');
const setIntervalSpy = spyOn(globalThis, 'setInterval');

// Mock process.once
const processOnce = spyMock(process, 'once');

// the queue is covered by its own suite; here just watch the wiring
const startJobQueue = spyMock(jobQueue, 'startJobQueue');
const stopJobQueue = spyMock(jobQueue, 'stopJobQueue');

describe('start', async () => {
  const botToken = 'test-token';

  const bot = await start(botToken);

  expect(updateYtdlp).toHaveBeenCalledTimes(1);
  expect(setIntervalSpy).toHaveBeenCalledWith(
    updateYtdlp,
    YTDLP_UPDATE_INTERVAL_MS,
  );

  expect(startJobQueue).toHaveBeenCalledWith(expect.any(Function));

  expect(processOnce).toHaveBeenCalledWith('SIGINT', expect.any(Function));
  expect(processOnce).toHaveBeenCalledWith('SIGTERM', expect.any(Function));

  bot.stop = mock();
  processOnce.mock.calls.find(([signal]) => signal === 'SIGINT')![1]();
  expect(bot.stop).toHaveBeenCalledWith('SIGINT');
  expect(stopJobQueue).toHaveBeenCalled();
  expect(abortDownloads).toHaveBeenCalled(); // downloads die; sends drain
  // the drain hold: keeps the process alive until jobs finish; run its tick
  // directly (the queue is idle here, so it clears itself)
  const holdTick = setIntervalSpy.mock.calls.findLast(
    ([, ms]) => ms === 250,
  )?.[0] as (() => void) | undefined;
  expect(holdTick).toBeDefined();
  holdTick!();

  // once-guarded: the second signal must not re-enter (a throwing second
  // bot.stop would kill the drain)
  processOnce.mock.calls.find(([signal]) => signal === 'SIGTERM')![1]();
  expect(bot.stop).toHaveBeenCalledTimes(1);

  it('constructs Telegraf with correct args', () => {
    expect(bot.telegram.token).toBe(botToken);
    expect(bot.telegram.options.apiRoot).toBe(apiRoot);
  });

  bot.telegram.getMe = mock(); // telegraf calls getMe when handling updates

  it('calls textMessageHandler with text messages', async () => {
    const msgUpdate: Update.MessageUpdate<Message.TextMessage> = {
      update_id: 1,
      message: {
        message_id: 2,
        date: Math.floor(Date.now() / 1000),
        text: 'foo',
        chat: { id: 123, type: 'private', first_name: 'Test' },
        from: {
          id: 456,
          is_bot: false,
          first_name: 'Test',
          username: 'testuser',
        },
      },
    };
    await bot.handleUpdate(msgUpdate);
    expect(textMessageHandler).toBeCalledTimes(1);
    expect(textMessageHandler.mock.calls[0]![0].update).toEqual(msgUpdate);
  });

  it('calls textMessageHandler with text message edits in private chats', async () => {
    const privateEdit: Update.EditedMessageUpdate<Message.TextMessage> = {
      update_id: 1,
      edited_message: {
        message_id: 2,
        date: Math.floor(Date.now() / 1000),
        edit_date: Math.floor(Date.now() / 1000),
        text: 'bar',
        chat: { id: 123, type: 'private', first_name: 'Test' },
        from: {
          id: 456,
          is_bot: false,
          first_name: 'Test',
          username: 'testuser',
        },
      },
    };
    await bot.handleUpdate(privateEdit);
    expect(textMessageHandler).toBeCalledTimes(1);
    expect(textMessageHandler.mock.calls[0]![0].update).toEqual(privateEdit);
  });

  it('does not call textMessageHandler with text message edits in group chats', async () => {
    const groupEdit: Update.EditedMessageUpdate<Message.TextMessage> = {
      update_id: 1,
      edited_message: {
        message_id: 2,
        date: Math.floor(Date.now() / 1000),
        edit_date: Math.floor(Date.now() / 1000),
        text: 'bar',
        chat: { id: 123, type: 'group', title: 'Test Group' },
        from: {
          id: 456,
          is_bot: false,
          first_name: 'Test',
          username: 'testuser',
        },
      },
    };
    const mockLog = spyMock(console, 'log');
    await bot.handleUpdate(groupEdit);
    expect(textMessageHandler).toBeCalledTimes(0);
    expect(mockLog).toBeCalledWith('unhandled update:', groupEdit);
  });

  it('calls inlineQueryHandler with inline queries', async () => {
    const inlineQuery: Update.InlineQueryUpdate = {
      update_id: 1,
      inline_query: {
        id: 'abc123',
        from: {
          id: 456,
          is_bot: false,
          first_name: 'Test',
          username: 'testuser',
        },
        query: 'test',
        offset: '',
        chat_type: 'private',
      },
    };
    await bot.handleUpdate(inlineQuery);
    expect(inlineQueryHandler).toBeCalledTimes(1);
    expect(inlineQueryHandler.mock.calls[0]![0].update).toEqual(inlineQuery);
  });

  it('calls callbackQueryHandler with callback queries', async () => {
    const callbackQuery: Update.CallbackQueryUpdate = {
      update_id: 1,
      callback_query: {
        id: 'cb123',
        from: {
          id: 456,
          is_bot: false,
          first_name: 'Test',
          username: 'testuser',
        },
        chat_instance: '456',
        data: 'dl:test-id',
      },
    };
    await bot.handleUpdate(callbackQuery);
    expect(callbackQueryHandler).toBeCalledTimes(1);
    expect(callbackQueryHandler.mock.calls[0]![0].update).toEqual(callbackQuery);
  });

  it('resolves only once launch reports the bot has started', async () => {
    launched = false; // suite-level start() already set it; reset to re-pin
    await start('test-token');
    expect(launched).toBe(true);
  });

  it('caps how long one update can block polling at 5 minutes', () => {
    expect((bot as any).options.handlerTimeout).toBe(5 * 60 * 1000);
  });

  const timeoutError = () =>
    Promise.reject(
      Object.assign(new Error('timed out'), { name: 'TimeoutError' }),
    );
  const inlineUpdate: Update.InlineQueryUpdate = {
    update_id: 98,
    inline_query: {
      id: 'slow1',
      from: { id: 456, is_bot: false, first_name: 'Test' },
      query: 'https://example.com',
      offset: '',
    },
  };

  it('treats an inline-query timeout as benign (work continues detached)', async () => {
    const consoleWarn = spyOn(console, 'warn').mockImplementation(mock());
    const consoleError = spyMock(console, 'error');
    inlineQueryHandler.mockImplementationOnce(timeoutError);
    // a rejection escaping handleUpdate crashes the bot; the slow handler must
    // be contained
    await expect(bot.handleUpdate(inlineUpdate)).resolves.toBeUndefined();
    expect(consoleWarn).toHaveBeenCalledWith(
      'Slow handler unblocked (still running):',
      expect.anything(),
    );
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('treats a timeout on an enqueue-only handler as a real error', async () => {
    const consoleError = spyMock(console, 'error');
    textMessageHandler.mockImplementationOnce(timeoutError);
    const hungUpdate: Update.MessageUpdate<Message.TextMessage> = {
      update_id: 97,
      message: {
        message_id: 99,
        date: Math.floor(Date.now() / 1000),
        text: 'hung',
        chat: { id: 123, type: 'private', first_name: 'Test' },
        from: { id: 456, is_bot: false, first_name: 'Test' },
      },
    };
    // logged as a real error but contained (an escaping rejection would crash the bot)
    await expect(bot.handleUpdate(hungUpdate)).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      'Unhandled error while processing',
      expect.anything(),
      expect.any(Error),
    );
  });

  it('exits the process if polling crashes fatally', async () => {
    const consoleError = spyMock(console, 'error');
    const exitSpy = spyOn(process, 'exit').mockImplementation(
      (() => undefined) as any,
    );
    (Telegraf.prototype.launch as any).mockImplementationOnce(async function (
      this: any,
      ...args: any[]
    ) {
      this.polling = {}; // crash strikes after polling had started
      args.find((a: any) => typeof a === 'function')?.();
      throw new Error('fatal polling error');
    });
    await start('crash-token');
    await Bun.sleep(1); // let the launch rejection reach the catch
    expect(consoleError).toHaveBeenCalledWith('Bot crashed:', expect.any(Error));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('contains handler errors instead of crashing the polling loop', async () => {
    const consoleError = spyMock(console, 'error');
    textMessageHandler.mockImplementationOnce(() =>
      Promise.reject(new Error('handler boom')),
    );
    const msgUpdate: Update.MessageUpdate<Message.TextMessage> = {
      update_id: 99,
      message: {
        message_id: 100,
        date: Math.floor(Date.now() / 1000),
        text: 'boom',
        chat: { id: 123, type: 'private', first_name: 'Test' },
        from: { id: 456, is_bot: false, first_name: 'Test' },
      },
    };
    // must resolve, not reject: a rejection escaping handleUpdate crashes the bot
    await expect(bot.handleUpdate(msgUpdate)).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      'Unhandled error while processing',
      expect.anything(),
      expect.any(Error),
    );
  });

  it('boot sweep actually deletes expired video_info and handled_urls rows', async () => {
    // pins the real end-to-end effect: a broken wiring (e.g. a missing import
    // whose ReferenceError the containment catch swallows) can only be caught
    // by asserting the rows are gone, not by watching mocks
    const { db, resetDb } = await import('../src/db');
    resetDb();
    const old = Date.now() - 8 * 24 * 60 * 60 * 1000; // past both TTLs
    seedInfoRow('https://stale', {}, old);
    db.query(
      'INSERT INTO handled_urls (chat_id, message_id, url, created_at) VALUES (1, 1, ?, ?)',
    ).run('https://stale', old);

    await start(botToken);

    expect(rowCount('video_info')).toBe(0);
    expect(rowCount('handled_urls')).toBe(0);
  });

  it('sweeps staging and legacy dirs on every boot, keeping the DB, blobs, and other staging', async () => {
    // our own staging orphan (a crash between yt-dlp's move and our rename),
    // a legacy cache dir, and ANOTHER bot's staging dir (may hold its
    // in-flight download, so it must survive our sweep)
    await mkdir('/storage/staging/generic', { recursive: true });
    await Bun.write('/storage/staging/generic/orphaned-final.mp4', 'x');
    await mkdir('/storage/_video-info', { recursive: true });
    await mkdir('/storage/staging-other', { recursive: true });
    await Bun.write('/storage/staging-other/in-flight.mp4', 'x');
    await mkdir('/storage/blobs', { recursive: true });

    await start(botToken); // every boot runs the sweep (nothing stages yet)

    expect(await stat('/storage/staging').catch(() => null)).toBeNull();
    expect(await stat('/storage/_video-info').catch(() => null)).toBeNull();
    // the SQLite files, blob dirs, and the other bot's staging survive
    expect(await stat('/storage/blobs').catch(() => null)).not.toBeNull();
    expect(await stat('/storage/mp4ify.db').catch(() => null)).not.toBeNull();
    expect(
      await stat('/storage/staging-other/in-flight.mp4').catch(() => null),
    ).not.toBeNull();
  });

  it('contains failing boot sweeps (storage and pending, incl. hourly)', async () => {
    // boot hygiene must never block boot; the hourly re-sweep shares that
    const consoleError = spyMock(console, 'error');
    // lazy rejections: an eager mockRejectedValue promise trips bun's
    // unhandled-rejection detector before the code under test can catch it
    const orphanSpy = spyOn(blobStore, 'sweepOrphanBlobs').mockImplementation(
      () => Promise.reject(new Error('disk is grumpy')),
    );
    const sweepSpy = spyOn(
      pendingDownloads,
      'sweepStalePending',
    ).mockImplementation(() => Promise.reject(new Error('db is grumpy')));
    try {
      await start(botToken); // must not reject
      expect(consoleError).toHaveBeenCalledWith(
        'sweepOrphanBlobs failed:',
        expect.any(Error),
      );
      expect(consoleError).toHaveBeenCalledWith(
        'sweepStalePending failed:',
        expect.any(Error),
      );
      const hourly = setIntervalSpy.mock.calls.findLast(
        ([, ms]) => ms === 60 * 60 * 1000,
      )![0] as () => void;
      await hourly();
      expect(
        consoleError.mock.calls.filter(
          ([m]) => m === 'sweepStalePending failed:',
        ),
      ).toHaveLength(2);
    } finally {
      orphanSpy.mockRestore();
      sweepSpy.mockRestore();
      consoleError.mockRestore();
    }
  });

  it('tolerates a missing storage root (fresh volume)', async () => {
    // readdir on a not-yet-created root must fall through, not throw
    await expect(
      sweepLegacyStorage('/storage/no-such-root', '/storage/no-such-staging'),
    ).resolves.toBeUndefined();
  });

  it('removes the pre-split shared-era store when running on per-bot paths', async () => {
    // scratch root, not /storage: the real sweep would delete the bare-default
    // DB this test container holds OPEN, stranding the suite on a ghost inode
    const root = '/storage/sweep-test';
    // scratch staging too: the default would rm the real /storage/staging
    const staging = `${root}/staging`;
    await mkdir(`${root}/blobs`, { recursive: true });
    await Bun.write(`${root}/mp4ify.db`, 'x'); // dev-scoped file_ids live here
    await Bun.write(`${root}/mp4ify.db-wal`, 'x');
    await Bun.write(`${root}/blobs/stale.mp4`, 'x');
    await Bun.write(`${root}/mp4ify-prod.db`, 'x'); // a per-bot DB must survive
    try {
      // on the bare defaults (DB_PATH unset) nothing is touched
      await sweepLegacyStorage(root, staging);
      expect(await stat(`${root}/mp4ify.db`).catch(() => null)).not.toBeNull();

      // per-bot DB but DEFAULT blob dir: the db goes, the (live!) blobs stay
      Bun.env.DB_PATH = '/storage/mp4ify-test.db';
      await sweepLegacyStorage(root, staging);
      expect(await stat(`${root}/mp4ify.db`).catch(() => null)).toBeNull();
      expect(await stat(`${root}/mp4ify.db-wal`).catch(() => null)).toBeNull();
      expect(await stat(`${root}/blobs`).catch(() => null)).not.toBeNull();
      expect(await stat(`${root}/mp4ify-prod.db`).catch(() => null)).not.toBeNull();

      // both paths explicitly per-bot: the bare-default blobs are dead too
      await Bun.write(`${root}/mp4ify.db`, 'x'); // re-seed the era marker
      Bun.env.BLOB_DIR = '/storage/blobs-test';
      await sweepLegacyStorage(root, staging);
      expect(await stat(`${root}/blobs`).catch(() => null)).toBeNull();
    } finally {
      delete Bun.env.DB_PATH;
      delete Bun.env.BLOB_DIR;
      await rm(root, { recursive: true, force: true });
    }
  });
});
