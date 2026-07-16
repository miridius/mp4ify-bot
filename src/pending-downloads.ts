import { blobKey, releaseAbandoned } from './blob-store';
import { db } from './db';
import type { ConfirmedJob } from './job-queue';

export const LONG_VIDEO_THRESHOLD_SECS = 20 * 60;

// An unanswered confirmation is abandoned after this long: a pre-download
// pending is already doomed past the info TTL (its payload's signed URLs
// expired), and a postDownload one pins its blob's bytes on disk for as long
// as the row lives, so ignored prompts would otherwise fill the volume.
export const PENDING_TTL_MS = 1000 * 60 * 60 * 6;
const staleRowIdsStmt = db.query<{ id: string }, [number]>(
  'SELECT id FROM pending WHERE created_at <= ?',
);
export const sweepStalePending = async () => {
  for (const { id } of staleRowIdsStmt.all(Date.now() - PENDING_TTL_MS)) {
    try {
      // Claim through THE atomic take (see takePendingStmt): the row must be
      // gone before releasing (releaseBlob counts pending refs), and a null
      // return means a confirm/cancel claimed it mid-sweep, so releasing
      // would drop bytes the adopted job now owns.
      const row = takePendingStmt.get(id);
      if (!row) continue;
      const download: PendingDownload = JSON.parse(row.payload);
      if (download.postDownload) {
        await releaseAbandoned(download.info);
      }
    } catch (e) {
      console.error(`Failed to release stale pending ${id}:`, e);
    }
  }
};

// a download parked awaiting the user's "yes": a confirmed job plus the
// requester id (for cancel auth). Confirming moves it straight into the job
// queue (see adoptJob), so the record is one state machine, never duplicated.
export type PendingDownload = ConfirmedJob & { userId: number };

const insertPendingStmt = db.query<
  null,
  [string, string, number, string | null, number]
>(
  'INSERT INTO pending (id, payload, user_id, blob_key, created_at) VALUES (?, ?, ?, ?, ?)',
);
const selectPendingStmt = db.query<{ payload: string }, [string]>(
  'SELECT payload FROM pending WHERE id = ?',
);
// THE atomic claim on a pending row. Exported so adoptJob (job-queue) and
// takePending below claim through the same statement: confirm and cancel
// racing on one row must contend on identical semantics, or the "exactly one
// wins" guarantee quietly forks.
export const takePendingStmt = db.query<{ payload: string }, [string]>(
  'DELETE FROM pending WHERE id = ? RETURNING payload',
);

export const addPending = async (
  download: Omit<PendingDownload, 'kind'>,
): Promise<string> => {
  const id = crypto.randomUUID();
  // stamp kind so the stored payload already IS a ConfirmedJob: adoptJob moves
  // it into the queue verbatim
  const payload = JSON.stringify({ kind: 'confirmed', ...download });
  // a postDownload confirmation already holds the bytes on disk; tag the blob it
  // owns so releaseBlob won't drop them while the user decides
  const key = download.postDownload ? blobKey(download.info) : null;
  insertPendingStmt.run(id, payload, download.userId, key, Date.now());
  return id;
};

export const getPending = async (
  id: string,
): Promise<PendingDownload | undefined> => {
  const row = selectPendingStmt.get(id);
  return row ? JSON.parse(row.payload) : undefined;
};

// read-and-remove in one atomic statement (DELETE … RETURNING): a concurrent
// confirm (adoptJob) and cancel can't both claim the same row: exactly one
// DELETE affects it; the other gets nothing.
export const takePending = async (
  id: string,
): Promise<PendingDownload | undefined> => {
  const row = takePendingStmt.get(id);
  return row ? JSON.parse(row.payload) : undefined;
};
