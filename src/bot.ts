import { readdir, rm, stat } from 'fs/promises';
import { basename } from 'path';
import { Telegraf } from 'telegraf';
import { allOf, editedMessage, message, type Filter } from 'telegraf/filters';
import type { Update } from 'telegraf/types';
import { apiRoot, STAGING_DIR } from './consts';
import {
  abortDownloads,
  sweepStaleInfo,
  updateYtdlp,
  YTDLP_UPDATE_INTERVAL_MS,
} from './download-video';
import {
  callbackQueryHandler,
  inlineIdle,
  inlineQueryHandler,
  processJob,
  sweepHandledUrls,
  textMessageHandler,
} from './handlers';
import { sweepOrphanBlobs } from './blob-store';
import { jobsIdle, startJobQueue, stopJobQueue } from './job-queue';
import { sweepStalePending } from './pending-downloads';

// Boot storage hygiene: every boot clears our own staging orphans and any
// /storage entry no bot accounts for; plus one-time cleanup for two eras
// (otherwise gigabytes of dead cache leak forever on the volume):
// 1. pre-SQLite: the old bot coordinated everything through files under
//    /storage (_jobs, _pending-downloads, _video-info + per-extractor video
//    dirs). None of it is readable by this code, so the sweep clears
//    everything except DB files, blob dirs, and staging dirs, logging each
//    removal so a foreign name can't vanish silently.
// 2. pre-split: before per-bot DB_PATH/BLOB_DIR, the dev bot wrote the bare
//    default paths on the shared volume. Its cached telegram file_ids are
//    dev-scoped (a 400 for any other bot), so for a bot running on explicit
//    per-bot paths the bare defaults are known-dead: remove them. Bots on
//    the defaults (the test container) skip this branch entirely.
// root/staging are parameters for the tests only: deleting the bare-default
// DB under the test container's OPEN connection would strand it on a ghost
// inode, so the suite exercises this against a scratch dir instead.
export const sweepLegacyStorage = async (
  root = '/storage',
  staging = STAGING_DIR,
) => {
  // The name prefixes cover both bots' conventional dirs; the basenames of
  // THIS bot's configured paths are kept too. NOTE the limit: a sweeping bot
  // cannot know its SIBLING's env, so an unconventionally-named store (e.g.
  // BLOB_DIR=/storage/videos) survives its own bot's sweep but not the other
  // bot's boot. Per-bot paths must keep the mp4ify/blobs/staging prefixes
  // (as docker-compose.yml's do).
  const keep = [Bun.env.DB_PATH, Bun.env.BLOB_DIR, Bun.env.STAGING_DIR]
    .filter((p): p is string => !!p)
    .map((p) => basename(p));
  // Staging dirs are per-bot: ANOTHER bot's may hold its in-flight download,
  // so only our own is cleared (below): at boot the queue has not started,
  // so anything in ours is an orphan (a crash left a downloaded file there).
  for (const name of await readdir(root).catch(() => [] as string[])) {
    if (
      name.startsWith('mp4ify') ||
      name.startsWith('blobs') ||
      name.startsWith('staging') ||
      keep.some((k) => name.startsWith(k))
    ) {
      continue;
    }
    console.log(`Sweeping stray /storage entry: ${name}`);
    await rm(`${root}/${name}`, { recursive: true, force: true });
  }
  await rm(staging, { recursive: true, force: true });
  // each deletion is guarded by ITS OWN path being explicitly non-default, so
  // a half-configured bot (per-bot DB, default blob dir) can't lose live data
  const dbElsewhere =
    Bun.env.DB_PATH && Bun.env.DB_PATH !== '/storage/mp4ify.db';
  const blobsElsewhere =
    Bun.env.BLOB_DIR &&
    !['/storage/blobs', '/storage/blobs/'].includes(Bun.env.BLOB_DIR);
  if (dbElsewhere && (await stat(`${root}/mp4ify.db`).catch(() => null))) {
    for (const name of ['mp4ify.db', 'mp4ify.db-wal', 'mp4ify.db-shm']) {
      await rm(`${root}/${name}`, { force: true });
    }
    if (blobsElsewhere) {
      await rm(`${root}/blobs`, { recursive: true, force: true });
    }
    console.log('Cleared pre-split shared-era store');
  }
};

// One containment for every hygiene sweep: none may block boot, and one
// failing sweep must not starve the others (a legacy-dir rm hiccup skipping
// the orphan sweep would leave crash-orphaned bytes unreclaimed; a stuck
// info sweep would starve the pending sweep that releases pinned blobs).
// Explicit label, not sweep.name: test spies replace the function.
const contain = async (label: string, sweep: () => unknown) => {
  try {
    await sweep();
  } catch (e) {
    console.error(`${label} failed:`, e);
  }
};

export const start = async (botToken: string) => {
  // boot-only storage reconciliation, BEFORE the queue starts (nothing else
  // is touching the dirs yet)
  await contain('sweepLegacyStorage', sweepLegacyStorage);
  await contain('sweepOrphanBlobs', sweepOrphanBlobs);

  // keep yt-dlp fresh: extractors break as sites change out from under us
  updateYtdlp();
  setInterval(updateYtdlp, YTDLP_UPDATE_INTERVAL_MS).unref();

  // Hourly TTL housekeeping (boot + interval), bounding growth between
  // boots: abandoned confirmations pin blob bytes until swept, and expired
  // video_info rows (megabytes of dump-json each) and handled_urls rows
  // otherwise accumulate for the whole uptime.
  const hourlySweep = async () => {
    await contain('sweepStaleInfo', sweepStaleInfo);
    await contain('sweepHandledUrls', sweepHandledUrls);
    await contain('sweepStalePending', sweepStalePending);
  };
  await hourlySweep();
  setInterval(hourlySweep, 60 * 60 * 1000).unref();

  const bot = new Telegraf(botToken, {
    telegram: { apiRoot },
    // downloads run via the job queue, so handlers are quick; this only
    // bounds stragglers (e.g. inline queries, which download in-handler)
    handlerTimeout: 5 * 60 * 1000,
  });
  console.debug(bot.telegram.options);

  bot.catch((err, ctx) => {
    // only inline queries legitimately run long (they download in-handler);
    // a timeout on the enqueue-only handlers means something is hung
    if (
      err instanceof Error &&
      err.name === 'TimeoutError' &&
      'inline_query' in ctx.update
    ) {
      // p-timeout rejection: the handler keeps running detached and its
      // work still completes; polling has already moved on
      console.warn('Slow handler unblocked (still running):', ctx.update);
      return;
    }
    // contained: the bot keeps polling, so don't taint the exit code, a
    // stale per-update error shouldn't make a later clean shutdown look failed
    console.error('Unhandled error while processing', ctx.update, err);
  });

  bot.on(message('text'), (ctx) => textMessageHandler(ctx));
  bot.on(
    allOf(
      editedMessage('text'),
      // group chats emit edited_message updates on emoji reactions too, so
      // process edits only for private chats. The handled_urls dedup (see
      // textMessageHandler) then ensures an edit only re-processes URLs that
      // actually changed, not the video it already sent.
      ((u: Update.EditedMessageUpdate) =>
        u.edited_message.chat.type ===
        'private') as Filter<Update.EditedMessageUpdate>,
    ),
    (ctx) => textMessageHandler(ctx),
  );
  bot.on('inline_query', (ctx) => inlineQueryHandler(ctx));
  bot.on('callback_query', (ctx) => callbackQueryHandler(ctx));

  bot.use((ctx) => console.log('unhandled update:', ctx.update));

  // Recover the persisted backlog BEFORE polling starts: a message processed
  // in the gap would enqueue ahead of last boot's interrupted jobs, inverting
  // the queue's FIFO promise. The processor only needs the telegram client,
  // which exists before launch.
  await startJobQueue((job, attempt) => processJob(bot.telegram, job, attempt));

  // launch() only settles when polling stops, so don't await it; a
  // rejection means polling died fatally: exit so docker restarts us
  await new Promise<void>((onLaunch) => {
    bot.launch(onLaunch).catch((e) => {
      console.error('Bot crashed:', e);
      process.exit(1);
    });
  });
  // onLaunch fires before telegraf assigns its polling field, and stop()
  // throws until it does - wait (bounded, in case telegraf renames it)
  const deadline = Date.now() + 30_000;
  while (!(bot as any).polling && Date.now() < deadline) await Bun.sleep(5);

  // Stop accepting work, kill the abortable phase (downloads re-run next boot
  // with no duplicate), stop polling; only the un-abortable mid-send tail
  // stays alive (see ShutdownAbort).
  // once-guarded: a second signal (SIGINT then compose's SIGTERM) must not
  // re-enter, and a throwing bot.stop would otherwise become an uncaught
  // exception that kills the drain this shutdown exists to provide
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopJobQueue();
    abortDownloads();
    try {
      bot.stop(signal);
    } catch (e) {
      console.error('bot.stop failed during shutdown:', e);
    }
    // explicit hold: keep the process alive until in-flight jobs AND inline
    // queries (which upload in-handler, with no durable row to recover) have
    // finished, rather than trusting a send's socket to hold Bun's event loop
    const hold = setInterval(() => {
      if (jobsIdle() && inlineIdle()) clearInterval(hold);
    }, 250);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  return bot;
};
