// Real-fs tests: the queue's durability is the point, so no mocks here.
import { afterAll, beforeEach, expect, it, jest, mock, spyOn } from 'bun:test';
import { mkdir, readdir, rm } from 'fs/promises';
import {
  enqueueJob,
  JOB_CONCURRENCY,
  jobsIdle,
  resetJobQueue,
  startJobQueue,
  type Job,
} from '../src/job-queue';
import { waitUntil } from './test-utils';

const JOBS_DIR = '/storage/_jobs/';

beforeEach(async () => {
  jest.clearAllMocks();
  resetJobQueue();
  await rm(JOBS_DIR, { recursive: true, force: true });
  await mkdir(JOBS_DIR, { recursive: true });
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

it('processes an enqueued job and removes its file', async () => {
  const processor = mock(async () => {});
  await startJobQueue(processor);

  await enqueueJob(job());

  await waitUntil(jobsIdle);
  expect(processor).toHaveBeenCalledWith(job(), expect.any(Function));
  expect(await readdir(JOBS_DIR)).toEqual([]);
});

it('keeps the job file until processing finishes', async () => {
  let finish!: () => void;
  const processor = mock(() => new Promise<void>((r) => (finish = r)));
  await startJobQueue(processor);

  await enqueueJob(job());
  await waitUntil(() => processor.mock.calls.length === 1);
  expect(await readdir(JOBS_DIR)).toHaveLength(1);

  finish();
  await waitUntil(jobsIdle);
  expect(await readdir(JOBS_DIR)).toEqual([]);
});

it('recovers persisted jobs on start', async () => {
  await Bun.write(`${JOBS_DIR}recovered.json`, JSON.stringify(job('https://r')));
  const processor = mock(async () => {});

  await startJobQueue(processor);

  await waitUntil(jobsIdle);
  expect(processor).toHaveBeenCalledWith(job('https://r'), expect.any(Function));
  expect(await readdir(JOBS_DIR)).toEqual([]);
});

it('does not double-process a job enqueued before start', async () => {
  await enqueueJob(job()); // no processor yet: file written, nothing runs
  expect(await readdir(JOBS_DIR)).toHaveLength(1);

  const processor = mock(async () => {});
  await startJobQueue(processor);

  await waitUntil(jobsIdle);
  expect(processor).toHaveBeenCalledTimes(1);
});

it(`runs at most ${JOB_CONCURRENCY} jobs concurrently`, async () => {
  const finishers: (() => void)[] = [];
  const processor = mock(
    () => new Promise<void>((r) => finishers.push(r)),
  );
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

it('discards unreadable job files without invoking the processor', async () => {
  const consoleError = spyOn(console, 'error').mockImplementation(mock());
  await Bun.write(`${JOBS_DIR}corrupt.json`, '{ not json');
  const processor = mock(async () => {});

  await startJobQueue(processor);

  await waitUntil(jobsIdle);
  expect(processor).not.toHaveBeenCalled();
  expect(await readdir(JOBS_DIR)).toEqual([]);
  expect(consoleError).toHaveBeenCalledWith(
    expect.stringContaining('Discarding unreadable job'),
    expect.anything(),
  );
});

it('removes the job file even when the processor throws', async () => {
  const consoleError = spyOn(console, 'error').mockImplementation(mock());
  const processor = mock(() => Promise.reject(new Error('processor bug')));
  await startJobQueue(processor);

  await enqueueJob(job());

  await waitUntil(jobsIdle);
  expect(await readdir(JOBS_DIR)).toEqual([]);
  expect(consoleError).toHaveBeenCalledWith(
    expect.stringContaining('failed:'),
    expect.any(Error),
  );
});

it('survives an unremovable job file', async () => {
  const consoleError = spyOn(console, 'error').mockImplementation(mock());
  // a directory named like a job: unreadable as JSON and unlink() fails
  await mkdir(`${JOBS_DIR}stuck.json`);
  const processor = mock(async () => {});

  await startJobQueue(processor);

  await waitUntil(() => consoleError.mock.calls.length > 0);
  expect(processor).not.toHaveBeenCalled();
  await rm(`${JOBS_DIR}stuck.json`, { recursive: true, force: true });
});

it('logs when a finished job file cannot be removed', async () => {
  const consoleError = spyOn(console, 'error').mockImplementation(mock());
  let finish!: () => void;
  const processor = mock(() => new Promise<void>((r) => (finish = r)));
  await startJobQueue(processor);
  await enqueueJob(job());
  await waitUntil(() => processor.mock.calls.length === 1);

  // swap the job file for a directory so the post-job unlink fails
  const [name] = await readdir(JOBS_DIR);
  await rm(`${JOBS_DIR}${name}`);
  await mkdir(`${JOBS_DIR}${name}`);
  finish();

  await waitUntil(() =>
    consoleError.mock.calls.some(([msg]) =>
      String(msg).includes('Failed to remove job file'),
    ),
  );
  await rm(`${JOBS_DIR}${name}`, { recursive: true, force: true });
});

it('does not start new jobs after stopJobQueue; recovery picks them up', async () => {
  const { stopJobQueue } = await import('../src/job-queue');
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
  expect(await readdir(JOBS_DIR)).toHaveLength(1); // parked job survives

  resetJobQueue();
  const processor2 = mock(async () => {});
  await startJobQueue(processor2);
  await waitUntil(jobsIdle);
  expect(processor2).toHaveBeenCalledWith(
    job('https://parked'),
    expect.any(Function),
  );
});

it('drops a job marked sending instead of replaying it on recovery', async () => {
  const consoleError = spyOn(console, 'error').mockImplementation(mock());
  let mark!: () => Promise<void>;
  let finish!: () => void;
  const processor = mock((_j: Job, markSending: () => Promise<void>) => {
    mark = markSending;
    return new Promise<void>((r) => (finish = r));
  });
  await startJobQueue(processor);
  await enqueueJob(job());
  await waitUntil(() => processor.mock.calls.length === 1);

  await mark();
  expect(await readdir(JOBS_DIR)).toEqual([
    expect.stringMatching(/\.sending$/),
  ]);

  // simulate the crash: never finish; reset and recover in a "new process"
  resetJobQueue();
  const processor2 = mock(async () => {});
  await startJobQueue(processor2);
  // can't wait on jobsIdle: the crashed run still holds a worker slot
  await waitUntil(
    () =>
      consoleError.mock.calls.length > 0 &&
      processor2.mock.calls.length === 0,
    1000,
  );
  expect(processor2).not.toHaveBeenCalled();
  expect(await readdir(JOBS_DIR)).toEqual([]);
  expect(consoleError).toHaveBeenCalledWith(
    expect.stringContaining('interrupted mid-send'),
  );
  finish(); // let the original run's cleanup settle
});

it('recovers persisted jobs in FIFO order', async () => {
  await Bun.write(`${JOBS_DIR}1-a.json`, JSON.stringify(job('https://first')));
  await Bun.write(`${JOBS_DIR}2-b.json`, JSON.stringify(job('https://second')));
  const order: string[] = [];
  await startJobQueue(async (j) => {
    order.push((j as { url: string }).url);
  });
  await waitUntil(jobsIdle);
  expect(order).toEqual(['https://first', 'https://second']);
});
