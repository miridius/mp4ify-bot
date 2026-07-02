import { Database } from 'bun:sqlite';

// One embedded SQLite database is the durable coordination store: the job
// queue, parked confirmations, the identity-keyed blob index, and the URL
// info cache all live here as tables, so every multi-step state change is one
// transaction. bun:sqlite
// is built into Bun (no dependency, no separate process) and synchronous, so
// the store operations below are plain function calls, not awaits.
const DB_PATH = Bun.env.DB_PATH || '/storage/mp4ify.db';

export const db = new Database(DB_PATH, { create: true });
// WAL: a crash mid-write rolls back cleanly. busy_timeout is defensive for any
// future second connection: today exactly one process opens each DB file.
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');

// Schema (and one-time data fixes) versioned by `PRAGMA user_version`: each
// entry is applied once, in order, inside a transaction. Append new
// migrations; never edit an applied one. Exported for the migration tests.
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE jobs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT, -- FIFO via ORDER BY id
    payload    TEXT    NOT NULL,                   -- JSON Job (UrlJob | ConfirmedJob)
    attempts   INTEGER NOT NULL DEFAULT 0,         -- retries so far; bumped before re-queue
    created_at INTEGER NOT NULL                    -- forensic only: jobs have no TTL
  );

  CREATE TABLE pending (
    id         TEXT    PRIMARY KEY,                -- uuid carried in the confirm/cancel buttons
    payload    TEXT    NOT NULL,                   -- JSON ConfirmedJob
    user_id    INTEGER NOT NULL,                   -- only this user may cancel
    blob_key   TEXT,                               -- the pre-downloaded blob it keeps alive
    created_at INTEGER NOT NULL
  );
  CREATE INDEX pending_blob ON pending (blob_key);

  CREATE TABLE blobs (
    key        TEXT    PRIMARY KEY,                -- source identity: extractor:id:format
    path       TEXT    NOT NULL,                   -- on-disk location of the bytes
    file_id    TEXT,                               -- telegram file_id once sent (bytes then disposable)
    created_at INTEGER NOT NULL
  );

  CREATE TABLE video_info (
    url         TEXT    PRIMARY KEY,               -- a looked-up URL; aliases each get their own row
    info        TEXT    NOT NULL,                  -- JSON VideoInfo
    created_at  INTEGER NOT NULL
  );
  `,
  `
  -- the ffprobe'd real duration, kept on the blob row so the long-video gate
  -- still works after the bytes are disposed (see blob-store / processUrlJob)
  ALTER TABLE blobs ADD COLUMN duration INTEGER;

  -- URLs already processed from a message, so an edited message (which
  -- re-triggers the handler) only re-processes URLs that actually changed
  -- instead of re-sending the same video (see textMessageHandler)
  CREATE TABLE handled_urls (
    chat_id    INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    url        TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, message_id, url)
  );
  `,
  // rows keyed by the generic extractor predate blobKey's generic exclusion
  // (its id is just the URL basename, not an identity); no lookup can address
  // them anymore, and their file_id-null rows would pin their bytes through
  // the orphan sweep forever
  `DELETE FROM blobs WHERE key LIKE 'generic:%';`,
  // removeCachedInfo evicts a video's url row AND its aliases by the embedded
  // canonical URL; without this index that DELETE json_extracts every row's
  // multi-MB payload, synchronously, on every failed download attempt
  `CREATE INDEX video_info_webpage
   ON video_info (json_extract(info, '$.webpage_url'));`,
  // Replace the expression index above with a real column: the expression
  // index re-parses the multi-MB JSON payload on every insert/upsert (twice
  // per scrape, once per alias), so store webpage_url denormalized and index
  // that.
  `ALTER TABLE video_info ADD COLUMN webpage_url TEXT;
   UPDATE video_info SET webpage_url = json_extract(info, '$.webpage_url');
   CREATE INDEX video_info_webpage_col ON video_info (webpage_url);
   DROP INDEX video_info_webpage;`,
];

// Exported so the migration tests replay THIS loop against a scratch DB (a
// copy in the test would let the shipping migrator drift unpinned). `until`
// lets a test stop at an old era, seed rows that era wrote, and resume.
export const migrate = (target: Database, until = MIGRATIONS.length) => {
  const userVersion = () =>
    (target.query('PRAGMA user_version').get() as { user_version: number })
      .user_version;
  for (let v = userVersion(); v < until; v++) {
    target.transaction(() => {
      target.exec(MIGRATIONS[v]!);
      target.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }
};
migrate(db);

// throwing inside fn rolls the whole transaction back (bun:sqlite semantics)
export const tx = <T>(fn: () => T): T => db.transaction(fn)();

// test-only: drop every row and reset AUTOINCREMENT so a suite starts from a
// known-empty store (the container's DB persists within one `bun test` run).
export const resetDb = () => {
  db.exec(
    'DELETE FROM jobs; DELETE FROM pending; DELETE FROM blobs; DELETE FROM video_info; DELETE FROM handled_urls; DELETE FROM sqlite_sequence;',
  );
};
