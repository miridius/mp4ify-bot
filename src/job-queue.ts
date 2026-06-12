import { mkdir, readdir, rename, unlink } from 'fs/promises';
import type { PendingDownload } from './pending-downloads';

export type UrlJob = {
  kind: 'url';
  url: string;
  chatId: number;
  chatType: string;
  messageId: number;
  fromId: number;
  verbose: boolean;
};

export type ConfirmedJob = { kind: 'confirmed' } & Omit<
  PendingDownload,
  'userId'
>;

export type Job = UrlJob | ConfirmedJob;

const JOBS_DIR = '/storage/_jobs/';
await mkdir(JOBS_DIR, { recursive: true });

export const JOB_CONCURRENCY = 3;

// markSending flips the job to at-most-once: call it right before the
// telegram send, so a crash after delivery can't replay the send on boot
type Processor = (job: Job, markSending: () => Promise<void>) => Promise<void>;
let processor: Processor | undefined;
const pending: string[] = [];
// every queued or in-flight id: the recovery scan races concurrent
// enqueues and completions, and must not re-queue what is already known
const known = new Set<string>();
let active = 0;
let stopped = false;

const file = (id: string) => Bun.file(`${JOBS_DIR}${id}.json`);
const sendingPath = (id: string) => `${JOBS_DIR}${id}.sending`;

const markJobSending = (id: string) =>
  rename(file(id).name!, sendingPath(id)).catch((e) =>
    console.error(`Failed to mark job ${id} as sending:`, e),
  );

// the job file is written before this resolves: once the handler returns
// (and telegram considers the update acked), the queue entry is the
// durable record, so a restart re-runs it instead of losing it
export const enqueueJob = async (job: Job) => {
  // timestamp prefix: readdir order is filesystem-dependent, so recovery
  // sorts by name to keep cross-restart FIFO
  const id = `${Date.now()}-${crypto.randomUUID()}`;
  known.add(id);
  await Bun.write(file(id), JSON.stringify(job));
  pending.push(id);
  pump();
};

export const startJobQueue = async (p: Processor) => {
  processor = p;
  await mkdir(JOBS_DIR, { recursive: true }); // e2e wipes /storage wholesale
  const names = (await readdir(JOBS_DIR)).sort();
  for (const name of names) {
    if (name.endsWith('.sending')) {
      // the crash hit between marking and cleanup — the send very likely
      // went out, so replaying it would duplicate the message
      console.error(`Dropping job ${name}: interrupted mid-send`);
      await unlink(JOBS_DIR + name).catch(() => {});
      continue;
    }
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    if (!known.has(id)) {
      known.add(id);
      pending.push(id);
    }
  }
  pump();
};

// stop starting jobs (in-flight ones finish); their files survive for the
// next boot's recovery scan
export const stopJobQueue = () => {
  stopped = true;
};

// test-only: drop queue state so suites can start fresh
export const resetJobQueue = () => {
  processor = undefined;
  pending.length = 0;
  known.clear();
  stopped = false;
};

export const jobsIdle = () => active === 0 && pending.length === 0;

const pump = () => {
  while (!stopped && processor && active < JOB_CONCURRENCY && pending.length > 0) {
    const id = pending.shift()!;
    active++;
    void run(id).finally(() => {
      active--;
      pump();
    });
  }
};

const run = async (id: string) => {
  const f = file(id);
  let job: Job;
  try {
    job = await f.json();
  } catch (e) {
    console.error(`Discarding unreadable job ${id}:`, e);
    await f.unlink().catch(() => {});
    return;
  }
  try {
    await processor!(job, () => markJobSending(id));
  } catch (e) {
    // the processor reports its own failures to the user; reaching here is
    // a bug, and retrying a deterministic bug would crash-loop on boot
    console.error(`Job ${id} failed:`, e);
  }
  await unlink(sendingPath(id)).catch(() => {});
  await f
    .unlink()
    .catch((e) =>
      e.code === 'ENOENT'
        ? undefined // it was renamed to .sending and removed above
        : console.error(`Failed to remove job file ${id}:`, e),
    );
  known.delete(id);
};
