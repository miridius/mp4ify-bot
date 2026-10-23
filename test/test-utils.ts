import { expect, mock, spyOn } from 'bun:test';
import { mkdir, rm, truncate } from 'fs/promises';
import { blobPath, recordBlob } from '../src/blob-store';
import { db } from '../src/db';
import { jobsIdle } from '../src/job-queue';
import type { MockBotApi } from './simulate-bot-api';
import { MAX_FILE_SIZE_BYTES, type VideoInfo } from '../src/download-video';

// Tests that replace or delete the cookie jar both bots share on /storage run
// only in the test container (the dev container sets STAGING_DIR)
export const OWNS_COOKIE_JAR = !Bun.env.STAGING_DIR;

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
  Object.assign(new Error(`${code}: ${description}`), {
    response: { error_code: code, description },
  });

// seed a video_info row the way getInfos stores a single-video post
// (webpage_url denormalized into its own column, mirroring insertInfoStmt)
export const seedInfoRow = (
  url: string,
  info: Partial<VideoInfo>,
  createdAt = Date.now(),
) => {
  const stored = { webpage_url: url, ...info };
  return db
    .query(
      'INSERT INTO video_info (url, info, webpage_url, created_at) VALUES (?, ?, ?, ?)',
    )
    .run(url, JSON.stringify([stored]), stored.webpage_url, createdAt);
};

/**
 * Sleeps until `fn()` returns truthy or `timeout` millis (default: 4000) have
 * elapsed. Returns whether the condition held at the end (false = timed out),
 * so a caller can tell a satisfied wait from an abandoned one. Works with sync
 * and async predicates alike (awaiting a plain value passes it through).
 */
export const waitUntil = async (fn: () => any, timeout = 4000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end && !(await fn())) await Bun.sleep(10);
  return !!(await fn());
};

export const settle = async (
  api: MockBotApi,
  update: { update_id: number },
  timeout = 10_000,
  context?: () => string,
) => {
  const expectWithin = async (what: string, fn: () => boolean, ms: number) => {
    const ok = await waitUntil(fn, ms);
    expect(
      ok,
      ok ? undefined : `${what} within ${ms}ms${context ? `: ${context()}` : ''}`,
    ).toBe(true);
  };
  await expectWithin(
    'update handled',
    () => api.handledOffset > update.update_id,
    4000,
  );
  await expectWithin('jobs idle', jobsIdle, timeout);
};

// control files for the test/bin stub executables (on PATH via Dockerfile.dev)
export const STUB_DIR = '/tmp/stub';
// `dir` may be a per-phase subdir: while download/ (yt-dlp --load-info-json
// calls) or ffprobe/ exists, that stub reads all its control files from it;
// args always log to STUB_DIR
export const stub = (files: Record<string, string>, dir = STUB_DIR) =>
  Promise.all(
    Object.entries(files).map(([k, v]) => Bun.write(`${dir}/${k}`, v)),
  );
export const stubArgs = async () =>
  (
    await Bun.file(`${STUB_DIR}/args`)
      .text()
      .catch(() => '')
  ).trim();
export const cookiesArg = async () => (await stubArgs()).match(/--cookies (\S+)/)?.[1];
export const stubSpawns = async () =>
  (await stubArgs()).split('\n').filter(Boolean);
export const stubScrape = (
  infos: object[],
  extra: Record<string, string> = {},
) =>
  stub({
    stdout: infos.map((i) => JSON.stringify(i)).join('\n') + '\n',
    ...extra,
  });
export const unblockStub = () => rm(`${STUB_DIR}/block`, { force: true });
export const resetStub = async () => {
  await rm(STUB_DIR, { recursive: true, force: true });
  await mkdir(STUB_DIR, { recursive: true });
};

export const urlMessage = (url: string) => ({
  text: url,
  entities: [{ offset: 0, length: url.length, type: 'url' as const }],
  link_preview_options: { is_disabled: true },
});

export const seedHandledUrl = (
  chatId: number,
  messageId: number,
  url: string,
  createdAt = Date.now(),
) =>
  db
    .query(
      'INSERT INTO handled_urls (chat_id, message_id, url, created_at) VALUES (?, ?, ?, ?)',
    )
    .run(chatId, messageId, url, createdAt);

export const mp4BlobPath = (info: VideoInfo) => blobPath(info, '.mp4');
export const recordMp4Blob = (info: VideoInfo) =>
  recordBlob(info, mp4BlobPath(info));
export const seedBytes = async (info: VideoInfo, bytes = 'video bytes') => {
  await Bun.write(mp4BlobPath(info), bytes);
  recordMp4Blob(info);
};
export const seedOversize = async (info: VideoInfo) => {
  const path = mp4BlobPath(info);
  await Bun.write(path, '');
  await truncate(path, MAX_FILE_SIZE_BYTES + 1024 * 1024);
  recordMp4Blob(info);
};
export const bytesOnDisk = (info: VideoInfo) => Bun.file(mp4BlobPath(info)).exists();
