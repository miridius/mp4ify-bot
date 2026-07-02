// Real-DB tests: the queue's durability is the point, so no mocks of the store.
import { afterAll, beforeEach, expect, it, jest, mock } from 'bun:test';
import { db, resetDb } from '../src/db';
import {
  adoptJob,
  enqueueJob,
  JOB_CONCURRENCY,
  jobsIdle,
  knownCount,
  resetJobQueue,
  seedJob,
  setRetryBaseMs,
  ShutdownAbort,
  startJobQueue,
  stopJobQueue,
  type Job,
} from '../src/job-queue';
import { addPending, getPending } from '../src/pending-downloads';
import { rowCount, spyMock, waitUntil, withFailingWrite } from './test-utils';

beforeEach(() => {
  jest.clearAllMocks();
  resetJobQueue();
  resetDb();
});
afterAll(() => mock.restore());

const job = (url = 'https://example.com'): Job => ({
  kind: 'url',
  url,
  chatId: 1,
  chatType: 'private',
  messageId: 2,
  fromId: 3,
  verbose: false,
});

it('an enqueue landing after stop stays durable but out of dispatch', async () => {
  const processor = mock(async () => {});
  await startJobQueue(processor);
  stopJobQueue();

  await enqueueJob(job()); // e.g. a text handler that was already in flight

  expect(jobsIdle()).toBe(true); // must not wedge the drain hold
  expect(processor).not.toHaveBeenCalled();
  expect(rowCount('jobs')).toBe(1); // durable; the next boot runs it
});

it('stopJobQueue drops the queued backlog so the drain hold can clear', async () => {
  let finish!: () => void;
  // one slot: job A occupies it, job B waits in `pending`
  resetJobQueue(1);
  const processor = mock(() => new Promise<void>((r) => (finish = r)));
  await startJobQueue(processor);
  await enqueueJob(job('https://a.example'));
  await enqueueJob(job('https://b.example'));
  await waitUntil(() => processor.mock.calls.length === 1);

  stopJobQueue();
  expect(jobsIdle()).toBe(false); // A still draining
  finish();
  await waitUntil(jobsIdle); // B's queued id must not wedge this forever
  expect(rowCount('jobs')).toBe(1); // B's row survives for next-boot recovery
});

it('a retryable failure during shutdown persists the bump but schedules no timer', async () => {
  const processor = mock(async () => {
    stopJobQueue(); // shutdown lands while this attempt is in flight...
    throw new Error('429 mid-drain'); // ...and the attempt then fails retryably
  });
  await startJobQueue(processor);

  await enqueueJob(job());

  await waitUntil(jobsIdle); // a scheduled retry timer would keep this false
  expect(processor).toHaveBeenCalledTimes(1);
  const row = db
    .query('SELECT attempts FROM jobs')
    .get() as { attempts: number } | null;
  expect(row).not.toBeNull(); // row kept for next boot...
  expect(row!.attempts).toBe(1); // ...with the burned attempt recorded
});

it('a shutdown abort keeps the row and attempt budget, persisting the log pointer', async () => {
  const processor = mock(async (j: Job) => {
    j.logMessageId = 777; // the processor stashes its progress message...
    throw new ShutdownAbort();
  });
  await startJobQueue(processor);

  await enqueueJob(job());

  await waitUntil(jobsIdle); // no retry timer keeps the queue busy
  expect(processor).toHaveBeenCalledTimes(1); // not retried in-process
  const row = db
    .query('SELECT attempts, payload FROM jobs')
    .get() as { attempts: number; payload: string } | null;
  expect(row).not.toBeNull(); // the row survives for next-boot recovery
  expect(row!.attempts).toBe(0); // full attempt budget intact
  // ...and it rides the payload, so the re-run continues one thread
  expect(JSON.parse(row!.payload).logMessageId).toBe(777);
});

it('processes an enqueued job and removes its row', async () => {
  const processor = mock(async () => {});
  await startJobQueue(processor);

  await enqueueJob(job());

  await waitUntil(jobsIdle);
  expect(processor).toHaveBeenCalledWith(job(), 1);
  expect(rowCount('jobs')).toBe(0);
});

it('keeps the job row until processing finishes', async () => {
  let finish!: () => void;
  const processor = mock(() => new Promise<void>((r) => (finish = r)));
  await startJobQueue(processor);

  await enqueueJob(job());
  await waitUntil(() => processor.mock.calls.length === 1);
  expect(rowCount('jobs')).toBe(1);

  finish();
  await waitUntil(jobsIdle);
  expect(rowCount('jobs')).toBe(0);
});

it('recovers persisted jobs on start', async () => {
  seedJob(job('https://r'));
  const processor = mock(async () => {});

  await startJobQueue(processor);

  await waitUntil(jobsIdle);
  expect(processor).toHaveBeenCalledWith(job('https://r'), 1);
  expect(rowCount('jobs')).toBe(0);
});

it('does not double-process a job enqueued before start', async () => {
  await enqueueJob(job()); // no processor yet: row written, pump no-ops
  expect(rowCount('jobs')).toBe(1);

  const processor = mock(async () => {});
  await startJobQueue(processor);

  await waitUntil(jobsIdle);
  expect(processor).toHaveBeenCalledTimes(1); // known dedup: not run twice
});

it(`runs at most ${JOB_CONCURRENCY} jobs concurrently`, async () => {
  const finishers: (() => void)[] = [];
  const processor = mock(() => new Promise<void>((r) => finishers.push(r)));
  await startJobQueue(processor);

  for (let i = 0; i < JOB_CONCURRENCY + 2; i++) {
    await enqueueJob(job(`https://example.com/${i}`));
  }

  await waitUntil(() => finishers.length === JOB_CONCURRENCY);
  await Bun.sleep(50); // give an over-cap job the chance to (wrongly) start
  expect(processor).toHaveBeenCalledTimes(JOB_CONCURRENCY);

  finishers.forEach((finish) => finish());
  // the queued-over-cap jobs only start (and push finishers) now
  await waitUntil(() => finishers.length === JOB_CONCURRENCY + 2);
  finishers.slice(JOB_CONCURRENCY).forEach((finish) => finish());
  await waitUntil(jobsIdle);
  expect(processor).toHaveBeenCalledTimes(JOB_CONCURRENCY + 2);
});

it('discards an unreadable job row without invoking the processor', async () => {
  const consoleError = spyMock(console, 'error');
  // a row whose payload isn't valid JSON (corruption analogue)
  db.query('INSERT INTO jobs (payload, created_at) VALUES (?, ?)').run(
    '{ not json',
    Date.now(),
  );
  const processor = mock(async () => {});

  await startJobQueue(processor);

  await waitUntil(jobsIdle);
  expect(processor).not.toHaveBeenCalled();
  expect(rowCount('jobs')).toBe(0);
  expect(consoleError).toHaveBeenCalledWith(
    expect.stringContaining('Discarding unreadable job'),
    expect.anything(),
  );
});

it('retries an unexpectedly-failing job a few times, then drops it', async () => {
  const consoleError = spyMock(console, 'error');
  const processor = mock(() => Promise.reject(new Error('processor bug')));
  await startJobQueue(processor);

  await enqueueJob(job());

  await waitUntil(jobsIdle);
  expect(processor).toHaveBeenCalledTimes(3);
  expect(processor.mock.calls.map((c) => c[1])).toEqual([1, 2, 3]);
  expect(rowCount('jobs')).toBe(0);
  expect(consoleError).toHaveBeenCalledWith(
    expect.stringContaining('attempt 1/3'),
    expect.any(Error),
  );
  expect(consoleError).toHaveBeenCalledWith(
    expect.stringContaining('after 3 attempts, dropping'),
    expect.any(Error),
  );
});

it('drops a job (not orphans it) when persisting the retry fails', async () => {
  const consoleError = spyMock(console, 'error');
  seedJob(job()); // recovery, not enqueue, runs it
  const processor = mock(() => Promise.reject(new Error('processor bug')));
  // the retry-count UPDATE throws, a disk-full analogue
  await withFailingWrite('jobs', 'UPDATE', async () => {
    await startJobQueue(processor);
    await waitUntil(jobsIdle);
  });

  expect(processor).toHaveBeenCalledTimes(1); // not retried in a loop
  expect(rowCount('jobs')).toBe(0);
  expect(consoleError).toHaveBeenCalledWith(
    expect.stringContaining('Failed to persist retry'),
    expect.any(Error),
  );
});

it('frees a queued id whose row vanished before it ran', async () => {
  await enqueueJob(job()); // no processor yet: the row is written, id parked
  const { id } = db.query('SELECT id FROM jobs').get() as { id: number };
  db.query('DELETE FROM jobs WHERE id = ?').run(id); // the row disappears

  const processor = mock(async () => {});
  await startJobQueue(processor); // pump runs the parked id, but its row is gone

  await waitUntil(jobsIdle);
  expect(processor).not.toHaveBeenCalled(); // a null row is a benign skip
  expect(knownCount()).toBe(0); // the id was freed, not wedged
});

it('frees the id (not wedges it) when the post-run row delete throws', async () => {
  const consoleError = spyMock(console, 'error');
  const processor = mock(async () => {}); // succeeds; run() then deletes the row
  // a disk-error analogue: the completion DELETE raises. run()'s throw must be
  // caught at the pump's fire-and-forget boundary so the id is freed, not left
  // wedged in `known`.
  await withFailingWrite('jobs', 'DELETE', async () => {
    await startJobQueue(processor);
    await enqueueJob(job());
    await waitUntil(() => knownCount() === 0); // the boundary catch freed the id
  });

  expect(consoleError).toHaveBeenCalledWith(
    expect.stringContaining('crashed in queue bookkeeping'),
    expect.any(Error),
  );
  expect(jobsIdle()).toBe(true);
  expect(rowCount('jobs')).toBe(1); // the delete failed, so the row survives
});

it('rolls back its known-id reservation when the enqueue write fails', async () => {
  spyMock(console, 'error');
  await startJobQueue(mock(async () => {}));
  await withFailingWrite('jobs', 'INSERT', async () => {
    await expect(enqueueJob(job())).rejects.toThrow('ENOSPC');
  });

  expect(rowCount('jobs')).toBe(0);
  expect(knownCount()).toBe(0);
  expect(jobsIdle()).toBe(true);
});

it("rolls a guard's writes back when the enqueue insert fails", async () => {
  spyMock(console, 'error');
  await startJobQueue(mock(async () => {}));
  // the guard records handled_urls the way textMessageHandler does; a kill
  // or failure between two separate commits would mark the URL handled with
  // no job row, silently dropping it forever: one tx makes that impossible
  await withFailingWrite('jobs', 'INSERT', async () => {
    await expect(
      enqueueJob(
        job(),
        () =>
          db
            .query(
              'INSERT INTO handled_urls (chat_id, message_id, url, created_at) VALUES (1, 2, ?, ?)',
            )
            .run('https://x', Date.now()).changes > 0,
      ),
    ).rejects.toThrow('ENOSPC');
  });

  expect(rowCount('jobs')).toBe(0);
  expect(rowCount('handled_urls')).toBe(0); // rolled back with the insert
});

it('skips the enqueue (no row, no dispatch) when the guard returns false', async () => {
  const processor = mock(async () => {});
  await startJobQueue(processor);

  await enqueueJob(job(), () => false);

  expect(rowCount('jobs')).toBe(0);
  expect(knownCount()).toBe(0);
  await Bun.sleep(10);
  expect(processor).not.toHaveBeenCalled();
});

it('backs off before retrying, and is not idle during the backoff', async () => {
  spyMock(console, 'error');
  setRetryBaseMs(200);
  let calls = 0;
  const processor = mock(() => {
    calls++;
    return calls === 1
      ? Promise.reject(new Error('transient'))
      : Promise.resolve();
  });
  await startJobQueue(processor);

  await enqueueJob(job());
  await waitUntil(() => processor.mock.calls.length === 1);
  await Bun.sleep(20); // let the failed run() finish scheduling the retry

  // the job is waiting out the ~200ms backoff: not active, not pending, but
  // the queue must not report idle (a retry is still owed)
  expect(jobsIdle()).toBe(false);
  expect(processor).toHaveBeenCalledTimes(1); // not re-run immediately

  await waitUntil(jobsIdle, 2000);
  expect(processor).toHaveBeenCalledTimes(2); // retried after the backoff
  expect(rowCount('jobs')).toBe(0);
});

it('does not retry a job that eventually succeeds', async () => {
  spyMock(console, 'error');
  let calls = 0;
  const processor = mock(() => {
    calls++;
    return calls === 1
      ? Promise.reject(new Error('transient'))
      : Promise.resolve();
  });
  await startJobQueue(processor);

  await enqueueJob(job());

  await waitUntil(jobsIdle);
  expect(processor).toHaveBeenCalledTimes(2);
  expect(rowCount('jobs')).toBe(0);
});

it('carries a processor mutation forward to the retry', async () => {
  spyMock(console, 'error');
  const seen: (number | undefined)[] = [];
  let n = 0;
  const processor = mock(async (j: Job) => {
    seen.push(j.logMessageId);
    if (n++ === 0) {
      j.logMessageId = 99; // the processor stashes a value (e.g. a message id)
      throw new Error('transient'); // ...then fails, asking for a retry
    }
  });
  await startJobQueue(processor);

  await enqueueJob(job());

  await waitUntil(jobsIdle);
  expect(seen).toEqual([undefined, 99]); // the retry saw the persisted mutation
});

it('clears a pending retry backoff on stop (the row recovers next boot)', async () => {
  spyMock(console, 'error');
  setRetryBaseMs(500);
  const processor = mock(() => Promise.reject(new Error('fail')));
  await startJobQueue(processor);
  await enqueueJob(job());
  await waitUntil(() => processor.mock.calls.length === 1);
  await Bun.sleep(20); // first attempt failed; a retry is now in backoff
  expect(jobsIdle()).toBe(false);

  stopJobQueue();
  expect(jobsIdle()).toBe(true); // the backoff timer was cleared
  expect(rowCount('jobs')).toBe(1); // row survives for recovery
});

it('does not start new jobs after stopJobQueue; recovery picks them up', async () => {
  let finish!: () => void;
  const processor = mock(() => new Promise<void>((r) => (finish = r)));
  await startJobQueue(processor);
  await enqueueJob(job('https://running'));
  await waitUntil(() => processor.mock.calls.length === 1);

  stopJobQueue();
  await enqueueJob(job('https://parked'));
  finish();
  await Bun.sleep(100);
  expect(processor).toHaveBeenCalledTimes(1);
  expect(rowCount('jobs')).toBe(1); // the parked job's row remains

  resetJobQueue();
  const processor2 = mock(async () => {});
  await startJobQueue(processor2);
  await waitUntil(jobsIdle);
  expect(processor2).toHaveBeenCalledWith(job('https://parked'), 1);
});

it('re-runs an interrupted job on recovery (at-least-once)', async () => {
  // a job whose process died mid-run leaves its row behind
  seedJob(job('https://interrupted'));
  const processor = mock(async () => {});
  await startJobQueue(processor);
  await waitUntil(jobsIdle);
  expect(processor).toHaveBeenCalledWith(job('https://interrupted'), 1);
});

it('adoptJob moves a parked confirmation into the queue and runs it', async () => {
  const id = await addPending({
    info: { filename: 'v.mp4', title: 'T' },
    verbose: false,
    messageId: 2,
    chatId: 1,
    postDownload: false,
    userId: 3,
  });
  const processor = mock(async () => {});
  await startJobQueue(processor);

  await adoptJob(id);

  await waitUntil(jobsIdle);
  expect(processor).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'confirmed' }),
    1,
  );
  expect(await getPending(id)).toBeUndefined(); // moved, not copied
  expect(rowCount('jobs')).toBe(0);
});

it('adoptJob returns false when the pending row is already gone', async () => {
  await startJobQueue(mock(async () => {}));
  expect(await adoptJob('no-such-id')).toBe(false);
  expect(rowCount('jobs')).toBe(0); // nothing enqueued for the missing row
});

it('recovers persisted jobs in FIFO order', async () => {
  // concurrency 1: jobs process sequentially, so processor-call order equals
  // dequeue order (the monotonic id ORDER BY under test)
  resetJobQueue(1);
  seedJob(job('https://first'));
  seedJob(job('https://second'));
  const order: string[] = [];
  await startJobQueue(async (j) => {
    order.push((j as { url: string }).url);
  });
  await waitUntil(jobsIdle);
  expect(order).toEqual(['https://first', 'https://second']);
});
