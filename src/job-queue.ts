import { db, tx } from './db';
import type { VideoInfo } from './download-video';
import { takePendingStmt } from './pending-downloads';

// fields both job kinds share; job mutations persist on the retry bump and
// the shutdown stash (the queue re-serializes the job object it handed out)
type JobBase = {
  chatId: number;
  // group failure reports show only the terminal line (see reportJobFailure)
  chatType: string;
  messageId: number;
  verbose: boolean;
  // the reply we report progress/errors in (id + its content so far); persisted
  // across retries so each attempt CONTINUES one message (appending below the
  // prior attempt's lines) rather than spawning or wiping one
  logMessageId?: number;
  logText?: string;
};

export type UrlJob = JobBase & {
  kind: 'url';
  url: string;
  fromId: number;
  // the videos of a multi-video post this job is done with (sent, or ruled out
  // by a gate), by videoKey, so a retry picks up where it stopped
  settledIds?: string[];
  // and the ones whose info block already reached the chat, so a retry does
  // not print it again for a video it announced but could not deliver
  announcedIds?: string[];
  // whether the post has answered the message at all: a video sent, or a
  // confirmation prompt parked. Either is a promise the edit-retry gesture
  // must not undo by re-running the whole post.
  answered?: true;
  // whether the "more than N videos here" notice already reached the chat, so
  // a retry's continued thread doesn't print it twice (its text may sit in an
  // earlier chunk than the one logText carries, so string-matching logText
  // can't answer this)
  capShown?: boolean;
};

export type ConfirmedJob = JobBase & {
  kind: 'confirmed';
  info: VideoInfo;
  postDownload: boolean;
  // the normalized URL the originating message recorded in handled_urls
  // (info.webpage_url may be a different alias), so a terminal failure can
  // un-record it and re-open the edit-retry gesture. Optional: rows parked
  // before this field existed lack it and just skip the un-record.
  url?: string;
  // this video is one of several in its post, so the message's record belongs
  // to the job delivering them all: un-recording it here would re-deliver the
  // ones that already landed
  partOfPost?: true;
};

export type Job = UrlJob | ConfirmedJob;

// Thrown when shutdown aborts a job's download (see abortDownloads). The queue
// keeps the row (no attempt burned, no retry timer, no user-facing report), so
// the next boot re-runs it; only the payload is refreshed, carrying the
// progress-message pointer so the re-run continues one thread. Downloads are
// the one abortable phase: bytes not yet sent can't duplicate. A job already
// past its download (mid-send) never sees this; it drains to completion,
// because the bot-api server finishes a started send even if we die (verified
// live), and only completing our own bookkeeping stops the re-run from
// re-sending.
export class ShutdownAbort extends Error {
  constructor() {
    super('restarting; the download will resume shortly');
    this.name = 'ShutdownAbort';
  }
}

export const JOB_CONCURRENCY = 3;
// the processor throws to request a retry, a retryable download error, or an
// unexpected bug. Retry a few times, then drop so a deterministic failure can't
// crash-loop the queue forever.
export const MAX_ATTEMPTS = 3;

// attempt is 1-based (1 on the first run, incremented per retry)
type Processor = (job: Job, attempt: number) => Promise<void>;
let processor: Processor | undefined;
let maxConcurrent = JOB_CONCURRENCY;
// in-memory dispatch state. The `jobs` table is the durable source of truth;
// these only schedule which rows this process is actively running, so the
// concurrency cap and backoff are pure in-memory bookkeeping (orthogonal to
// persistence, a restart rebuilds `pending` from the table).
const pending: number[] = [];
// every queued or in-flight id: the recovery scan races concurrent
// enqueues and completions, and must not re-queue what is already known
const known = new Set<number>();
let active = 0;
let stopped = false;
// retry backoff: a failed job waits out an exponential delay (+jitter) before
// re-queueing, so a transient cause (e.g. a 429) has time to clear and retries
// don't hammer in lockstep. A waiting job is neither active nor pending, so
// jobsIdle counts retryTimers.size too or the queue looks idle mid-retry. The
// wait is in-memory only (the backoff deadline is never persisted), so a restart
// re-runs immediately, which is harmless under at-least-once.
let retryBaseMs = 1000;
const retryTimers = new Set<Timer>();

// test-only: shrink the backoff so suites don't sleep real seconds per retry.
export const setRetryBaseMs = (ms: number) => {
  retryBaseMs = ms;
};

// exponential backoff with up to 100% jitter: ~1x, ~2x, ... the base
const backoffMs = (attempt: number) => {
  const base = retryBaseMs * 2 ** (attempt - 1);
  return base + Math.floor(Math.random() * base);
};

const insertJobStmt = db.query<{ id: number }, [string, number]>(
  'INSERT INTO jobs (payload, created_at) VALUES (?, ?) RETURNING id',
);
const selectJobStmt = db.query<{ payload: string; attempts: number }, [number]>(
  'SELECT payload, attempts FROM jobs WHERE id = ?',
);
const bumpAttemptsStmt = db.query<null, [number, string, number]>(
  'UPDATE jobs SET attempts = ?, payload = ? WHERE id = ?',
);
const bumpAttemptsOnlyStmt = db.query<null, [number, number]>(
  'UPDATE jobs SET attempts = ? WHERE id = ?',
);
const deleteJobStmt = db.query<null, [number]>('DELETE FROM jobs WHERE id = ?');
const selectJobIdsStmt = db.query<{ id: number }, []>(
  'SELECT id FROM jobs ORDER BY id',
);

// the `!`: RETURNING always yields a row here, or .get() throws
const insertJob = (job: Job): number =>
  insertJobStmt.get(JSON.stringify(job), Date.now())!.id;

// Hand a freshly-committed row to the pump: the one dispatch mechanism for
// enqueue and adopt alike. A handler already in flight at shutdown can land
// here after stopJobQueue cleared the backlog: keep the row durable but out
// of dispatch, or its pending entry would wedge the drain hold (jobsIdle
// stays false).
const dispatch = (id: number) => {
  known.add(id);
  if (stopped) return;
  pending.push(id);
  pump();
};

// The row is committed before this resolves: once the handler returns (and
// telegram considers the update acked), the queue row is the durable record,
// so a restart re-runs it instead of losing it. The id only enters `known`
// after the insert succeeds, so a failed enqueue leaves no stale reservation.
// `guard` runs INSIDE the insert transaction; returning false skips the
// enqueue, and a failed insert rolls the guard's own writes back with it: a
// caller recording "I handled this" (see handled_urls) can never commit that
// record without the job row also committing, or vice versa.
export const enqueueJob = async (job: Job, guard?: () => boolean) => {
  const id = tx(() => {
    if (guard && !guard()) return null;
    return insertJob(job);
  });
  if (id != null) dispatch(id);
};

// Atomically move a parked confirmation (a `pending` row) into the queue: one
// transaction deletes the pending row and inserts the job, so the record is
// never lost or duplicated between the two states. Returns false if the pending
// row is already gone (already confirmed or cancelled): confirm and cancel both
// DELETE the same row, so exactly one wins.
// Deleting the pending row also drops the blob_key ref that kept a postDownload
// blob alive (refs are counted on `pending` only). That's safe: processConfirmedJob
// re-downloads if a concurrent release dropped the bytes meanwhile: see its
// downloadVideo call and releaseBlob.
export const adoptJob = async (id: string): Promise<boolean> => {
  const jobId = tx(() => {
    const row = takePendingStmt.get(id);
    if (!row) return null;
    return insertJobStmt.get(row.payload, Date.now())!.id;
  });
  if (jobId == null) return false;
  dispatch(jobId);
  return true;
};

export const startJobQueue = async (p: Processor) => {
  processor = p;
  // rebuild the dispatch queue from the durable table in FIFO order (the
  // monotonic id is the submission order); a row already in flight (`known`)
  // from a concurrent enqueue/adopt isn't re-queued.
  for (const { id } of selectJobIdsStmt.all()) {
    if (!known.has(id)) {
      known.add(id);
      pending.push(id);
    }
  }
  pump();
};

// stop starting jobs on shutdown; abortDownloads then kills the abortable
// phase, and bot.ts's drain hold keeps the process alive while jobs already
// mid-send finish and delete their rows. Queued rows survive for the next boot.
export const stopJobQueue = () => {
  stopped = true;
  // cancel retry backoffs and drop the queued backlog: a stopped queue won't
  // run either, their rows survive in the table for next-boot recovery, and
  // anything left here would keep jobsIdle() false, wedging the shutdown
  // drain hold until docker's SIGKILL
  for (const t of retryTimers) clearTimeout(t);
  retryTimers.clear();
  pending.length = 0;
};

// test-only: drop in-memory dispatch state so suites can start fresh. The DB is
// reset separately (resetDb): keeping them decoupled lets a test reset the
// queue's memory and then re-start to recover rows still in the table. The
// concurrency override forces sequential processing so recovery order is
// observable from the processor.
export const resetJobQueue = (concurrency = JOB_CONCURRENCY) => {
  processor = undefined;
  pending.length = 0;
  known.clear();
  active = 0; // a leftover in-flight count would shrink the next suite's cap
  stopped = false;
  maxConcurrent = concurrency;
  retryBaseMs = 1; // fast retries by default in tests; a test can raise it
  for (const t of retryTimers) clearTimeout(t); // don't fire into the next suite
  retryTimers.clear();
};

// test-only: insert a row directly (no pump), so the e2e can seed a job and
// then boot the bot to recover it.
export const seedJob = (job: Job) => insertJob(job);

export const jobsIdle = () =>
  active === 0 && pending.length === 0 && retryTimers.size === 0;

// test-only: reserved-id count, so a test can confirm a failed enqueue rolled
// back its reservation instead of silently growing `known`.
export const knownCount = () => known.size;

const pump = () => {
  while (!stopped && processor && active < maxConcurrent && pending.length > 0) {
    const id = pending.shift()!;
    active++;
    // run() reads the job row and deletes it on completion; a throw in that
    // bookkeeping (a corrupt-row read, a disk error on the delete) would
    // otherwise be an unhandled rejection that leaves the id wedged in `known`.
    // Catch it at the fire-and-forget boundary and free the id; the row
    // survives and re-runs on the next boot, a duplicate the queue's
    // at-least-once contract already permits. (Processor failures are handled
    // inside run(); only DB-level throws reach here.)
    void run(id)
      .catch((e) => {
        console.error(`Job ${id} crashed in queue bookkeeping:`, e);
        known.delete(id);
      })
      .finally(() => {
        active--;
        pump();
      });
  }
};

const run = async (id: number) => {
  const row = selectJobStmt.get(id);
  if (!row) {
    // the row is gone (e.g. a duplicate-queued id whose other run() finished
    // first): benign, not corruption
    known.delete(id);
    return;
  }
  let job: Job;
  try {
    job = JSON.parse(row.payload);
  } catch (e) {
    console.error(`Discarding unreadable job ${id}:`, e);
    deleteJobStmt.run(id);
    known.delete(id);
    return;
  }
  const attempt = row.attempts + 1;
  // The processor mutates its job through exactly these stash fields (e.g.
  // logMessageId so the retry edits one message); those mutations must
  // survive into the next run. Snapshotting them (cheap) lets the catch skip
  // re-serializing a ConfirmedJob's multi-MB dump-json payload when nothing
  // changed (the common group-job case, whose NoLog stashes nothing).
  const before = {
    logMessageId: job.logMessageId,
    logText: job.logText,
    capShown: (job as UrlJob).capShown,
    settled: (job as UrlJob).settledIds?.length,
    announced: (job as UrlJob).announcedIds?.length,
    answered: (job as UrlJob).answered,
  };
  try {
    await processor!(job, attempt);
  } catch (e) {
    const dirty =
      before.logMessageId !== job.logMessageId ||
      before.logText !== job.logText ||
      before.capShown !== (job as UrlJob).capShown ||
      before.settled !== (job as UrlJob).settledIds?.length ||
      before.announced !== (job as UrlJob).announcedIds?.length ||
      before.answered !== (job as UrlJob).answered;
    const persistJob = (attempts: number) =>
      dirty
        ? bumpAttemptsStmt.run(attempts, JSON.stringify(job), id)
        : bumpAttemptsOnlyStmt.run(attempts, id);
    if (e instanceof ShutdownAbort) {
      // row.attempts, not attempt: no attempt burned; persisted only for
      // the stashed log pointer (see ShutdownAbort)
      try {
        persistJob(row.attempts);
      } catch (writeErr) {
        console.error(`Failed to persist job ${id} at shutdown:`, writeErr);
      }
      console.log(`Job ${id} aborted for shutdown; it re-runs on the next boot`);
      return;
    }
    if (attempt < MAX_ATTEMPTS) {
      try {
        // persist the bump BEFORE re-queueing: if this write fails, fall through
        // and drop rather than orphan the job with a stale count that would
        // re-run forever across reboots
        persistJob(attempt);
        console.error(
          `Job ${id} failed (attempt ${attempt}/${MAX_ATTEMPTS}), retrying:`,
          e,
        );
        // a retryable failure DURING shutdown (e.g. a draining send hit a 429)
        // must not schedule a timer: it would re-arm what stopJobQueue just
        // cleared and wedge the drain hold. The bump is persisted; the row
        // retries on the next boot instead.
        if (stopped) return;
        // back off before retrying so a transient cause clears and we don't
        // re-hammer; the slot frees now (the finally), and the job reappears
        // in `pending` only when the timer fires. No delete/known.delete: the
        // retry reuses the same id and row. retryTimers tracks the wait so
        // jobsIdle stays busy until it fires.
        const timer = setTimeout(() => {
          retryTimers.delete(timer);
          pending.push(id);
          pump();
        }, backoffMs(attempt));
        // don't let a pending backoff hold the process open at shutdown.
        timer.unref?.();
        retryTimers.add(timer);
        return;
      } catch (writeErr) {
        // Deliberate trade-off: the user may already have been told "retrying…"
        // and any downloaded bytes stay on disk until this video is next
        // requested. A DB write failing means the disk is already in trouble:
        // dropping beats orphaning a row that would re-run forever.
        console.error(`Failed to persist retry for job ${id}, dropping:`, writeErr);
      }
    } else {
      console.error(`Job ${id} failed after ${MAX_ATTEMPTS} attempts, dropping:`, e);
    }
  }
  deleteJobStmt.run(id);
  known.delete(id);
};
