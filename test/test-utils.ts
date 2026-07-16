import { mock, spyOn } from 'bun:test';
import { db } from '../src/db';
import type { CallbackQueryContext, MessageContext } from '../src/types';

// Test-only memoize: production code uses coalesce + durable caches; mock
// implementations still want classic memoization (e.g. handlers.test's
// getInfo mock returning one stable object per URL).
export const memoize = <F extends (...args: any[]) => any>(
  f: F,
  key: (...args: Parameters<F>) => string | false = (...args) =>
    JSON.stringify(args),
): F & { cache: Map<string, ReturnType<F>> } => {
  const cache: Map<string, ReturnType<F>> = new Map();
  const memoized = ((...args: Parameters<F>): ReturnType<F> => {
    const k = key(...args);
    if (!k) return f(...args);
    if (!cache.has(k)) cache.set(k, f(...args));
    return cache.get(k)!;
  }) as F & { cache: Map<string, ReturnType<F>> };
  memoized.cache = cache;
  return memoized;
};

export const spyMock: typeof spyOn = (obj, k) =>
  spyOn(obj, k).mockImplementation(mock() as any);

// test-only: row count of a durable store table (jobs/pending are SQLite now),
// for "drained" / "no orphan" assertions
export const rowCount = (
  table: 'jobs' | 'pending' | 'blobs' | 'video_info' | 'handled_urls',
) =>
  (db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

spyMock(console, 'debug'); // suppress debug logs

// Drive a real SQLite write failure (no owned-code spy): a TEMP trigger makes
// the next <op> on <table> throw, a disk-full analogue. The DROP lives here so
// a forgotten cleanup can't leak the trigger onto the shared connection and
// poison every later test that touches the table.
export const withFailingWrite = async (
  table: string,
  op: 'INSERT' | 'UPDATE' | 'DELETE',
  fn: () => Promise<void> | void,
) => {
  db.exec(
    `CREATE TEMP TRIGGER failing_write BEFORE ${op} ON ${table} ` +
      "BEGIN SELECT RAISE(FAIL, 'ENOSPC'); END",
  );
  try {
    await fn();
  } finally {
    db.exec('DROP TRIGGER failing_write');
  }
};

// the error shape telegraf surfaces for a bot-api rejection; the contract
// isPermanentError/telegramDesc/errDesc parse, so tests must not hand-drift it
export const telegramError = (code: number, description: string) =>
  Object.assign(new Error(description), {
    response: { error_code: code, description },
  });

// seed a video_info row the way getInfo stores one (webpage_url denormalized
// into its own column, mirroring insertInfoStmt)
export const seedInfoRow = (
  url: string,
  info: unknown,
  createdAt = Date.now(),
) =>
  db
    .query(
      'INSERT INTO video_info (url, info, webpage_url, created_at) VALUES (?, ?, ?, ?)',
    )
    .run(
      url,
      JSON.stringify(info),
      (info as any)?.webpage_url ?? null,
      createdAt,
    );

/**
 * Sleeps until `fn()` returns truthy or `timeout` millis (default: 4000) have
 * elapsed. Returns whether the condition held at the end (false = timed out),
 * so a caller can tell a satisfied wait from an abandoned one. Works with sync
 * and async predicates alike (awaiting a plain value passes it through).
 */
export const waitUntil = async (fn: () => any, timeout = 4000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end && !(await fn())) await Bun.sleep(100);
  return !!(await fn());
};

let nextMsgId = 100;

// Helper to create a mock MessageContext
export const createMockMessageCtx = (
  isEdit: boolean,
  overrides?: { chat?: any; from?: any },
): MessageContext => {
  const chat = overrides?.chat ?? { id: 123, type: 'private' };
  const from = overrides?.from ?? { id: 123, is_bot: false };
  return {
    [isEdit ? 'editedMessage' : 'message']: {
      text: 'https://example.com',
      entities: [{ type: 'url', offset: 0, length: 19 }],
      message_id: 1,
      from,
      chat,
    },
    chat,
    telegram: {
      sendVideo: mock(),
      sendMessage: mock(async (_chatId: number, text: string) => ({
        text,
        chat,
        message_id: nextMsgId++,
      })),
    },
  } as any;
};

// Helper to create a mock CallbackQueryContext
export const createMockCallbackCtx = (
  data: string,
  userId: number = 123,
): CallbackQueryContext =>
  ({
    callbackQuery: {
      id: '12345',
      from: { id: userId, is_bot: false, first_name: 'Test' },
      message: {
        message_id: 50,
        from: { id: 999, is_bot: true },
        chat: { id: userId, type: 'private' },
        text: 'Download this video?',
      },
      chat_instance: String(userId),
      data,
    },
    from: { id: userId, is_bot: false },
    // confirmed-job failures report through a (mocked) LogMessage, so the
    // callback ctx's telegram is only ever passed through, never called
    telegram: {},
    answerCbQuery: mock(async () => {}),
    deleteMessage: mock(async () => {}),
  }) as any;
