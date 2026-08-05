import { mkdir, readdir } from 'fs/promises';
import { db, tx } from './db';
import type { VideoInfo } from './download-video';
import { unlinkQuiet } from './fs-utils';
import { keyedLock } from './utils';

// downloaded video bytes live here, named by the video's source identity (see
// blobKey), so two URLs for the same video share one file and no title/URL
// collision can misname or alias it. Env-configurable so the dev and prod bots
// (which share the /storage volume) keep separate stores (like DB_PATH in db.ts).
const envDir = Bun.env.BLOB_DIR || '/storage/blobs/';
const BLOB_DIR = envDir.endsWith('/') ? envDir : `${envDir}/`;
await mkdir(BLOB_DIR, { recursive: true });

// the generic extractor's id is just the URL basename: two hosts' /video.mp4
// both yield id 'video'
const hasVideoIdentity = (info: VideoInfo): boolean =>
  !!(info.extractor && info.id && info.extractor !== 'generic');

// A blob's key is yt-dlp's stable per-video identity, extractor:id:format
// (known from --dump-json before the download), so a blob we already have is found
// without re-downloading, and two URLs for one video resolve to the same key.
// NOT content-addressed: the key never depends on the bytes. When an extractor
// omits the identity fields, fall back to the yt-dlp filename salted with the
// canonical URL: the filename alone is title-derived, and two DIFFERENT videos
// with colliding titles would otherwise share a key (and, worse, the first one's
// cached file_id). This is the raw DB key; blobName turns it into the on-disk
// filename.
export const blobKey = (info: VideoInfo): string =>
  hasVideoIdentity(info)
    ? `${info.extractor}:${info.id}:${info.format_id ?? ''}`
    : info.webpage_url
      ? `${info.filename}:${info.webpage_url}`
      : info.filename;

// The fallback cannot reuse blobKey's filename, which carries the format id (see
// yt-dlp.conf's --output); yt-dlp suffixes " (N)" to the titles of one page's
// entries, so title still separates them.
export const videoKey = (info: VideoInfo): string =>
  hasVideoIdentity(info)
    ? `${info.extractor}:${info.id}`
    : `${info.title}:${info.id ?? ''}:${info.webpage_url ?? ''}`;

const extOf = (info: VideoInfo) => {
  const e =
    info.ext ||
    (info.filename.includes('.') ? info.filename.split('.').pop() : '');
  return e ? `.${e}` : '';
};

// cut to at most maxBytes of UTF-8 without leaving a split code point: a cut
// mid-codepoint decodes to a trailing U+FFFD, which we drop; that also keeps
// the result within maxBytes (the dropped partial bytes don't re-expand).
const truncateBytes = (s: string, maxBytes: number): string => {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length <= maxBytes) return s;
  const cut = new TextDecoder().decode(bytes.subarray(0, maxBytes));
  // 0xFFFD is the replacement char a split trailing code point decodes to
  return cut.charCodeAt(cut.length - 1) === 0xfffd ? cut.slice(0, -1) : cut;
};

// Turn a blob key + extension into the on-disk filename, handling both
// filesystem concerns here so blobKey stays a clean DB key:
//  - percent-escape '/' (the one character hostile to the path), '%' first so a
//    literal '%' can't forge an escape (a no-op for real identities);
//  - bound it to ext4's 255-byte NAME_MAX, leaving room for the `.json` sidecar
//    (blobPath + ".json"). A real name is far under; a pathological one (the
//    generic extractor's URL-as-id, the filename fallback, or a junk extension)
//    is truncated and tagged with a short hash of the full key, so two long keys
//    sharing a prefix still land on distinct files.
const NAME_MAX = 255;
const blobName = (key: string, ext: string): string => {
  const stem = key.replaceAll('%', '%25').replaceAll('/', '%2F');
  // the extension gets the same escape (a hostile ext with '/' would otherwise
  // path-traverse out of BLOB_DIR) and a clamp so a pathological one can't
  // crowd out the whole budget and leave the name unbounded
  const safeExt = truncateBytes(
    ext.replaceAll('%', '%25').replaceAll('/', '%2F'),
    16,
  );
  const budget = NAME_MAX - Buffer.byteLength(safeExt) - '.json'.length;
  if (Buffer.byteLength(stem) <= budget) return stem + safeExt;
  const tag = `~${Bun.hash(stem).toString(36)}`;
  return truncateBytes(stem, budget - tag.length) + tag + safeExt;
};

export const blobPath = (info: VideoInfo): string =>
  `${BLOB_DIR}${blobName(blobKey(info), extOf(info))}`;

type BlobRow = { path: string; file_id: string | null; duration: number | null };
const selectBlobStmt = db.query<BlobRow, [string]>(
  'SELECT path, file_id, duration FROM blobs WHERE key = ?',
);
// the DO UPDATE refreshes created_at: it is the age the boot sweep reclaims
// un-uploaded blobs by, and a re-download restarts that clock
const upsertBlobStmt = db.query<null, [string, string, number]>(
  `INSERT INTO blobs (key, path, created_at) VALUES (?, ?, ?)
   ON CONFLICT(key) DO UPDATE
   SET path = excluded.path, created_at = excluded.created_at`,
);
const setFileIdStmt = db.query<null, [string, string]>(
  'UPDATE blobs SET file_id = ? WHERE key = ?',
);
const deleteBlobStmt = db.query<null, [string]>(
  'DELETE FROM blobs WHERE key = ?',
);
// a blob is kept alive by every parked confirmation that still owns it
const countRefsStmt = db.query<{ n: number }, [string]>(
  'SELECT count(*) AS n FROM pending WHERE blob_key = ?',
);

// the DB record for a video's blob, or null if we have none. file_id set means
// it's already uploaded (bytes disposable, resend by id); otherwise the bytes
// are on disk at .path.
export const getBlob = (info: VideoInfo): BlobRow | null =>
  selectBlobStmt.get(blobKey(info));

// record freshly-downloaded bytes (overwrites any stale row for the key)
export const recordBlob = (info: VideoInfo) =>
  upsertBlobStmt.run(blobKey(info), blobPath(info), Date.now());

// cache the telegram file_id after a first upload; the bytes can then be dropped
export const setBlobFileId = (info: VideoInfo, fileId: string) =>
  setFileIdStmt.run(fileId, blobKey(info));

const setDurationStmt = db.query<null, [number, string]>(
  'UPDATE blobs SET duration = ? WHERE key = ?',
);
const clearFileIdStmt = db.query<null, [string]>(
  'UPDATE blobs SET file_id = NULL WHERE key = ?',
);
// record the ffprobe'd real duration (scraped metadata can lack it); it lives on
// the blob row so the long-video confirmation gate still has it after the bytes
// are disposed post-upload (probing then is impossible)
export const setBlobDuration = (info: VideoInfo, secs: number) =>
  setDurationStmt.run(secs, blobKey(info));

// Telegram rejected the cached file_id (e.g. the bot-api server's data volume
// was recreated, invalidating every stored id): clear it so isDownloaded stops
// short-circuiting and the retry re-downloads, instead of the video being
// permanently unsendable
export const clearBlobFileId = (info: VideoInfo) =>
  clearFileIdStmt.run(blobKey(info));

// Per-blob serialization. Every operation that materializes, sends, or deletes
// a blob's bytes runs under this lock keyed on the blob key, so two jobs
// for the same video take turns: the second reuses the first's result (the
// cached file_id) or re-downloads cleanly if the first failed and discarded,
// instead of one deleting bytes the other is mid-upload on.
const blobLock = keyedLock();
export const withBlobLock = <T>(
  info: VideoInfo,
  fn: () => Promise<T>,
): Promise<T> => blobLock(blobKey(info), fn);

// Boot-time reconciliation of the blob dir against the table: bytes that no
// row accounts for (a crash between rename and recordBlob), or that a row with
// a cached file_id no longer needs (a crash between setBlobFileId and the
// unlink), are unreachable by every other cleanup path and would leak forever.
// Runs before the queue starts, so nothing else is touching the dir.
const selectAllBlobsStmt = db.query<{ path: string; file_id: string | null }, []>(
  'SELECT path, file_id FROM blobs',
);
// Un-uploaded blob rows this old have no live owner left: legitimate pins are
// a parked confirmation (expires after PENDING_TTL_MS = 6h, and is excluded
// below anyway) or an active retry cycle (minutes). What remains is leaked
// bookkeeping from crash windows (a terminal failure whose release never ran,
// a pending payload that failed to parse), which nothing else can ever
// reclaim: dropping the row lets the path sweep below collect the bytes, and
// the worst case of a wrong guess is one re-download.
export const BLOB_TTL_MS = 24 * 60 * 60 * 1000;
const staleBlobsStmt = db.query<null, [number]>(
  `DELETE FROM blobs WHERE file_id IS NULL AND created_at <= ?
   AND key NOT IN (SELECT blob_key FROM pending WHERE blob_key IS NOT NULL)`,
);

export const sweepOrphanBlobs = async () => {
  staleBlobsStmt.run(Date.now() - BLOB_TTL_MS);
  const keep = new Set(
    selectAllBlobsStmt
      .all()
      .filter((r) => r.file_id == null)
      .map((r) => r.path),
  );
  for (const name of await readdir(BLOB_DIR).catch(() => [] as string[])) {
    // leaked .json sidecars (a crash beat downloadVideo's finally) are never
    // in `keep` either, so they sweep too
    const path = `${BLOB_DIR}${name}`;
    if (!keep.has(path)) await unlinkQuiet(path);
  }
};

// Drop a blob's bytes when no parked confirmation still references it and it was
// never uploaded (an uploaded blob keeps its row as the file_id cache; its
// bytes are already gone). The reference check and the row delete are one
// transaction, so two concurrent releases can't both decide to unlink; the
// unlink itself runs outside the transaction (it's a filesystem op).
export const releaseBlob = async (info: VideoInfo) => {
  const key = blobKey(info);
  const path = tx(() => {
    const blob = selectBlobStmt.get(key);
    if (!blob || blob.file_id) return null; // gone, or kept as the file_id cache
    if (countRefsStmt.get(key)!.n > 0) return null; // a pending still needs it
    deleteBlobStmt.run(key);
    return blob.path;
  });
  if (path) await unlinkQuiet(path);
};

// Release a download abandoned from OUTSIDE the blob lock: a cancel, a failed
// inline query, a terminal job whose own lock has already released, or the
// stale-pending sweep. Re-takes the lock so the release can't race a
// concurrent job for the same blob. (Code already holding the lock calls
// releaseBlob directly instead: re-taking here would self-deadlock.)
export const releaseAbandoned = (info: VideoInfo) =>
  withBlobLock(info, () => releaseBlob(info));
