import type { Telegram } from 'telegraf';
import {
  blobKey,
  getBlob,
  releaseAbandoned,
  releaseBlob,
  setBlobDuration,
  withBlobLock,
} from './blob-store';
import { db } from './db';
import {
  calcDuration,
  downloadVideo,
  getInfo,
  isDownloaded,
  isPermanentError,
  probeDuration,
  removeCachedInfo,
  sendInfo,
  sendVideo,
  tooLargeMessage,
  tooLargeToSend,
  YtdlpError,
  type VideoInfo,
} from './download-video';
import {
  adoptJob,
  enqueueJob,
  MAX_ATTEMPTS,
  ShutdownAbort,
  type ConfirmedJob,
  type Job,
  type UrlJob,
} from './job-queue';
import { LogMessage, logFor, NoLog } from './log-message';
import { telegramDesc } from './utils';
import {
  addPending,
  getPending,
  LONG_VIDEO_THRESHOLD_SECS,
  takePending,
} from './pending-downloads';
import type {
  CallbackQueryContext,
  InlineQueryContext,
  MessageContext,
} from './types';

const ensureScheme = (url: string) =>
  /^https?:\/\//i.test(url) ? url : `https://${url}`;

// URLs already processed from a message: an edited message re-triggers the
// handler (private chats only: see bot.ts), and without this a typo fix near
// the link would re-send the same video. Rows expire with the sweep below:
// Telegram reportedly stops delivering edits for messages older than about
// two days, so week-old rows can never be consulted again.
const selectHandledStmt = db.query<{ url: string }, [number, number]>(
  'SELECT url FROM handled_urls WHERE chat_id = ? AND message_id = ?',
);
const insertHandledStmt = db.query<null, [number, number, string, number]>(
  'INSERT OR IGNORE INTO handled_urls (chat_id, message_id, url, created_at) VALUES (?, ?, ?, ?)',
);
const deleteHandledStmt = db.query<null, [number, number, string]>(
  'DELETE FROM handled_urls WHERE chat_id = ? AND message_id = ? AND url = ?',
);
const sweepHandledStmt = db.query<null, [number]>(
  'DELETE FROM handled_urls WHERE created_at <= ?',
);
// called at boot and hourly by bot.ts (contained there: a disk-error throw
// at module load would crash boot instead of being hygiene-only)
export const sweepHandledUrls = () =>
  sweepHandledStmt.run(Date.now() - 7 * 24 * 60 * 60 * 1000);

// the LogMessage destination for a job: the reply target plus the stashed
// progress-message pointer so each attempt continues one thread (see LogDest)
const logDestFor = (job: Job) => ({
  chatId: job.chatId,
  replyTo: job.messageId,
  editMessageId: job.logMessageId,
  editText: job.logText,
});

// Stash the live message pointer (id + content) back onto the job so the next
// run continues the same thread rather than spawning or wiping one. undefined
// if this log's own send just failed; the retry then posts fresh (no message
// to edit, so no duplicate).
const stashLog = (job: Job, log: LogMessage) => {
  job.logMessageId = log.messageId;
  job.logText = log.text;
};

// Un-record the originating URL so editing the message retries it: a terminal
// verdict (a permanent failure, or a too-large gate) re-opens the edit-retry
// gesture, since yt-dlp may have self-updated or the site/format changed since.
// Guarded on url (confirmed jobs parked before the field existed lack it).
const reopenEditRetry = (job: Job, url?: string) => {
  if (url) deleteHandledStmt.run(job.chatId, job.messageId, url);
};

export const textMessageHandler = async (ctx: MessageContext) => {
  const { text, chat, entities, message_id, from } =
    ctx.message || ctx.editedMessage;
  console.debug('got message:', text);
  const verbose = chat.type === 'private' && text.startsWith('/verbose ');

  // normalize BEFORE deduping and recording: "example.com/v" and its
  // https-prefixed twin are one video, both within a message and across edits
  const urls = [
    ...new Set(
      entities
        ?.filter((e) => e.type === 'url')
        .map((e) => ensureScheme(text.slice(e.offset, e.offset + e.length))) ||
        [],
    ),
  ];
  const handled = new Set(
    selectHandledStmt.all(chat.id, message_id).map((r) => r.url),
  );

  await Promise.all(
    urls
      .filter((url) => !handled.has(url))
      .map(async (url) => {
        try {
          // The record is the enqueue guard: it commits in the SAME
          // transaction as the job row (a kill between two separate commits
          // would leave the URL marked handled with no job, silently dropped
          // forever), and it runs synchronously here, BEFORE any await:
          // telegraf dispatches a poll batch with Promise.all, so a message
          // and its edit can run these handlers concurrently, and a
          // post-await record would let both pass the handled pre-check.
          // (The .changes gate makes that concurrent duplicate lose on the
          // INSERT and skip the enqueue.)
          await enqueueJob(
            {
              kind: 'url',
              url,
              chatId: chat.id,
              chatType: chat.type,
              messageId: message_id,
              // `from` is always set on these messages (telegraf's NonChannel
              // type); the ?? 0 is dead-defensive: channel posts, the only
              // from-less case, arrive on channel_post, which we don't handle
              fromId: from?.id ?? 0,
              verbose,
            },
            () =>
              insertHandledStmt.run(chat.id, message_id, url, Date.now())
                .changes > 0,
          );
        } catch (e: any) {
          // the tx rolled the handled record back with the failed insert, so
          // the edit-retrigger path stays open for this URL
          console.error('Failed to enqueue download:', e);
          const report = logFor(ctx.telegram, chat.type, {
            chatId: chat.id,
            replyTo: message_id,
          });
          report.append(`💥 <b>Download failed</b>: ${errMsg(e)}`);
          await report.flush();
        }
      }),
  );
};

// Download then send, serialized under the blob lock so a concurrent job for
// the same video takes turns instead of racing on the bytes; this is the
// shared shape of confirmed-job and inline processing. (processUrlJob keeps its own block:
// it interleaves the post-download long-video gate inside the lock.) The download is
// unconditional even when the bytes were pre-downloaded: downloadVideo no-ops
// if the blob is still there and re-downloads if a concurrent cancel/failure
// released it: see releaseBlob.
const downloadAndSend = (
  telegram: Telegram,
  log: LogMessage,
  info: VideoInfo,
  verbose: boolean,
  chatId: number,
  replyTo?: number,
) =>
  withBlobLock(info, async () => {
    console.debug(await downloadVideo(log, info, verbose));
    return sendVideo(telegram, log, info, chatId, replyTo);
  });

export const processJob = async (
  telegram: Telegram,
  job: Job,
  attempt: number,
) =>
  job.kind === 'url'
    ? processUrlJob(telegram, job, attempt)
    : processConfirmedJob(telegram, job, attempt);

const processUrlJob = async (
  telegram: Telegram,
  job: UrlJob,
  attempt: number,
) => {
  const { url, chatId, chatType, messageId, verbose } = job;
  // progress logs go to private chats only: see logFor
  const log = logFor(telegram, chatType, logDestFor(job));
  let info: VideoInfo | undefined;
  try {
    info = await getInfo(log, url, verbose);
    // Print the info block once per DELIVERED thread: the flag says a prior
    // attempt appended it, and logMessageId says that attempt's sends
    // actually reached the chat (all-failed sends stash undefined, and the
    // retry posts a fresh thread that needs the info again).
    if (!(job.infoShown && job.logMessageId != null)) {
      await sendInfo(log, info, verbose);
    }
    job.infoShown = true;
    // a long video is often also too big to send; reject from the scraped
    // estimate before downloading (or offering to download) something we can
    // never deliver. sendVideo still gates on the real on-disk size for an
    // estimate that was missing or wrong. (A group's NoLog stays silent here,
    // matching the group-silence policy above.)
    const tooLarge = tooLargeToSend(info);
    if (tooLarge) {
      log.append(`\n${tooLargeMessage(tooLarge)}`);
      await log.flush();
      // estimates are unreliable and formats change, so an edit must be able
      // to retry this verdict too
      reopenEditRetry(job, url);
      return;
    }
    // scraped metadata can lack duration; the blob row keeps the ffprobe'd
    // real one from a previous download only if some past probe SUCCEEDED. A
    // probe-failed, later-disposed video (only file_id remains) stays unknown
    // and falls through.
    // `||`, not `??`: a scraped duration of 0 means "unknown" (the same reason
    // the post-download backstop re-checks 0), so it too falls through to the
    // blob row's probed duration
    const duration = calcDuration(info) || getBlob(info)?.duration;
    const isGroupChat = chatType !== 'private';
    if (isGroupChat && duration && duration > LONG_VIDEO_THRESHOLD_SECS) {
      await requestConfirmation(telegram, job, info, duration);
      return;
    }
    // set inside the lock when the post-download gate parks a confirmation, so
    // the too-large un-record below skips that (non-terminal) return path
    let confirmed = false;
    // serialize every byte-touching step for this video (download, probe, send)
    // so a concurrent job for the same blob takes turns with us: it reuses our
    // result or re-downloads cleanly, instead of racing us on the bytes
    const sent = await withBlobLock(info, async () => {
      console.debug(await downloadVideo(log, info!, verbose));
      if (isGroupChat) {
        // The real duration, probed and stored during the download just above
        // (or during the first download, when this one was a cache hit). A
        // null row value with bytes present (a crash landed between recording
        // the blob and storing the duration, or that probe failed once) is
        // re-probed here while the bytes are still on disk.
        const blob = getBlob(info!);
        let actualDuration = blob?.duration;
        if (!actualDuration && blob && !blob.file_id) {
          actualDuration = await probeDuration(blob.path);
          if (actualDuration) setBlobDuration(info!, actualDuration);
        }
        if (actualDuration && actualDuration > LONG_VIDEO_THRESHOLD_SECS) {
          // Enrich the parked payload too, so the confirmed job sends the
          // video with its real duration metadata. The probed duration is
          // already net of removed sponsor segments, so the chapters must go
          // or calcDuration would subtract them a second time.
          const infoWithDuration = {
            ...info!,
            duration: actualDuration,
            sponsorblock_chapters: undefined,
          };
          await requestConfirmation(
            telegram,
            job,
            infoWithDuration,
            actualDuration,
            true,
          );
          confirmed = true;
          return;
        }
      }
      return sendVideo(telegram, log, info!, chatId, messageId);
    });
    // sendVideo returns undefined when the real on-disk bytes exceeded the
    // limit (a missing/under estimate slipped past tooLargeToSend above); it
    // already discarded them. Un-record like a terminal verdict so an edit can
    // retry. The confirmation return path (confirmed) is not a too-large one.
    if (!sent && !confirmed) reopenEditRetry(job, url);
  } catch (e: any) {
    // not a failure: no report, no eviction, no release; stash the log
    // pointer for the re-run (see ShutdownAbort). Flush first: a debounced
    // first send may not have fired yet, and stashing undefined while the
    // timer posts during the drain would fork a duplicate thread next boot.
    if (e instanceof ShutdownAbort) {
      await log.flush();
      stashLog(job, log);
      throw e;
    }
    // a failed download often means the cached info's signed media URLs have
    // expired: evict so the retry (or the next request) re-scrapes. Scoped to
    // yt-dlp failures: after a send failure the info is fine, and keeping it
    // guarantees the retry maps to the same blob key and reuses the bytes.
    if (info && e instanceof YtdlpError) removeCachedInfo(info);
    await reportJobFailure(job, log, e, attempt, '\n');
    // reached only on a terminal failure (reportJobFailure rethrows retryable
    // ones, whose retry reuses the blob; a parked confirmation returned above).
    // Release the bytes this dead job downloaded.
    if (info) await releaseAbandoned(info);
    reopenEditRetry(job, url);
  }
};

const processConfirmedJob = async (
  telegram: Telegram,
  job: ConfirmedJob,
  attempt: number,
) => {
  let { info } = job;
  const { chatId, messageId, verbose } = job;
  const log = new NoLog();
  // confirmed jobs can be in group chats, so user-facing messages go through a
  // group-capable LogMessage (the progress NoLog above stays silent there)
  const report = () => new LogMessage(telegram, logDestFor(job));
  // No up-front size gate here: processUrlJob rejects a too-large estimate
  // before any confirmation is offered (see tooLargeToSend), so info's estimate
  // is already known-sendable. A real-bytes overshoot of a missing/under
  // estimate is the only surprise left: caught after the send below.
  try {
    // The payload pins the info snapshot the user confirmed, but its embedded
    // signed media URLs expire in hours; a confirm clicked later than that
    // would replay them into guaranteed 403s for every attempt. When there is
    // no blob yet (nothing downloaded to reuse), re-resolve through getInfo:
    // fresh within its TTL is a cheap DB hit, stale re-scrapes live URLs.
    // (Re-checked per attempt; a doomed replay evicts its row below, so the
    // NEXT attempt's getInfo re-scrapes. No unconditional retry refresh: a
    // retry whose blob survived, the common transient-send case, must reuse
    // its cached file_id rather than gamble on a fresh scrape.)
    if (info.webpage_url && !(await isDownloaded(info))) {
      info = await getInfo(log, info.webpage_url, verbose);
    }
    // the re-resolve can drift the key (e.g. a different format_id), stranding
    // the parked identity's (fileless) row; released here once so every outcome
    // path is covered (plain success, too-large, and the terminal catch below)
    if (blobKey(job.info) !== blobKey(info)) await releaseAbandoned(job.info);
    // the failure report below runs OUTSIDE downloadAndSend's blob lock so it
    // can't block a sibling job on a Telegram round-trip
    const sent = await downloadAndSend(
      telegram,
      log,
      info,
      verbose,
      chatId,
      messageId,
    );
    // sendVideo returns undefined only when the real bytes exceeded the limit
    // (the estimate was missing/under); it already discarded them, so just tell
    // the user. The confirm was an explicit action, so it earns a reply even in
    // a group: unlike a plain group url job, which stays silent (group-silence)
    // and so leaves this report to the private/inline paths.
    if (!sent) {
      const r = report();
      r.append(tooLargeMessage());
      await r.flush();
      reopenEditRetry(job, job.url);
    }
  } catch (e: any) {
    // a shutdown abort is not a failure; see processUrlJob's twin guard
    if (e instanceof ShutdownAbort) throw e;
    // evict likely-expired cached info so the NEXT request re-scrapes; this
    // job's own retries can't benefit (the payload pins its info snapshot)
    if (e instanceof YtdlpError) removeCachedInfo(info);
    await reportJobFailure(job, report(), e, attempt);
    // terminal failure (retryable ones rethrew above and will reuse the blob):
    // release what this dead job owns
    await releaseAbandoned(info);
    // un-record the originating message's URL so editing it retries, exactly
    // like a terminal url job (the payload carries the url the record used;
    // info.webpage_url may be a different alias)
    reopenEditRetry(job, job.url);
  }
};

const errMsg = (e: any) => Bun.escapeHTML(e?.message || String(e));

// Report a job failure on `log` (`prefix` separates it from any prior
// progress). Rethrows on a retryable error (stashing the message id so the
// retry edits the same message); returns on a permanent or final-attempt one.
const reportJobFailure = async (
  job: Job,
  log: LogMessage,
  e: any,
  attempt: number,
  prefix = '',
) => {
  console.error(e); // log first: reporting to the user can itself fail
  const retry = !isPermanentError(e) && attempt < MAX_ATTEMPTS;
  // The retry notice skips the reason (the streamed stderr above already shows
  // it, and the run isn't over) and trails a blank line to set off the next
  // attempt; the terminal report carries the reason. Groups see only that
  // terminal line: no retry play-by-play.
  const msg = retry
    ? `⚠️ <b>Download failed</b>, retrying (attempt ${attempt + 1} of ${MAX_ATTEMPTS})...\n`
    : `💥 <b>Download failed</b>: ${errMsg(e)}`;
  const isGroup = job.chatType !== 'private';
  // a deleted reply target means the requester revoked the request; a group
  // reply would be orphaned noise, so say nothing there (a report would reply
  // to the same gone message anyway)
  const orphaned = /message to be replied not found/i.test(telegramDesc(e));
  try {
    if (!(isGroup && (retry || orphaned))) {
      log.append(prefix + msg);
      await log.flush();
    }
  } catch (notifyErr) {
    console.error('Failed to report the error to the user:', notifyErr);
  }
  if (retry) {
    stashLog(job, log);
    throw e;
  }
};

const formatDuration = (secs: number) => {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
};

// `duration` is passed in, not recomputed from info: the caller may have
// resolved it from the blob row (metadata had none) or from a fresh probe, and
// re-deriving it here would re-subtract sponsor time from an already-net value
const requestConfirmation = async (
  telegram: Telegram,
  job: UrlJob,
  info: VideoInfo,
  duration: number,
  postDownload: boolean = false,
) => {
  const id = await addPending({
    info,
    url: job.url, // rides along so a terminal confirmed job can un-record it
    verbose: job.verbose,
    messageId: job.messageId,
    chatId: job.chatId,
    chatType: job.chatType,
    userId: job.fromId,
    postDownload,
  });

  try {
    await telegram.sendMessage(
      job.chatId,
      `This video is pretty long (${formatDuration(duration)}), do you want me to download it anyway?`,
      {
        reply_parameters: { message_id: job.messageId },
        reply_markup: {
          inline_keyboard: [
            [
              { text: '👍 Yes please', callback_data: `dl:${id}` },
              { text: '👎 No thanks', callback_data: `no:${id}` },
            ],
          ],
        },
        disable_notification: true,
      },
    );
  } catch (e) {
    // the buttons carry this id; if the send fails they never reach the user,
    // so the pending can never be consumed: drop it before rethrowing, along
    // with the blob any postDownload confirmation already owns
    const pending = await takePending(id);
    if (pending?.postDownload) {
      // plain releaseBlob, NOT releaseAbandoned: the postDownload prompt is
      // sent from inside the caller's blob lock, and re-taking it here would
      // deadlock on our own key
      await releaseBlob(pending.info);
    }
    throw e;
  }
};

const safeAnswer = (ctx: CallbackQueryContext, text: string) =>
  ctx
    .answerCbQuery(text)
    .catch((e) => console.error('answerCbQuery failed:', e));

const safeDelete = (ctx: CallbackQueryContext) =>
  ctx.deleteMessage().catch((e) => console.error('deleteMessage failed:', e));

const handleUnavailable = async (ctx: CallbackQueryContext) => {
  await safeAnswer(ctx, 'This request is no longer available.');
  await safeDelete(ctx);
};

export const callbackQueryHandler = async (ctx: CallbackQueryContext) => {
  try {
    await handleCallbackQuery(ctx);
  } catch (e) {
    // bot.catch would contain this too, but only answering the callback
    // query stops the user's button from spinning forever
    console.error('Error handling callback query:', e);
    await safeAnswer(ctx, 'Something went wrong.');
  }
};

const handleCallbackQuery = async (ctx: CallbackQueryContext) => {
  const data = (ctx.callbackQuery as any).data as string | undefined;
  if (!data) return;

  const match = data.match(/^(dl|no):([a-z0-9-]+)$/);
  if (!match) {
    console.error('Unrecognized callback data:', data);
    await safeAnswer(ctx, '');
    return;
  }

  const [, action, id] = match;

  if (action === 'no') {
    // peek (don't remove) for the auth check, so an unauthorized cancel never
    // claims the pending row a concurrent confirm may be adopting
    const pending = await getPending(id);
    if (!pending) {
      await handleUnavailable(ctx);
      return;
    }
    if (ctx.from!.id !== pending.userId) {
      await safeAnswer(ctx, 'Only the requester can cancel.');
      return;
    }
    // authorized: remove it now. A concurrent confirm may have adopted it
    // between the peek and here, so it's already in the queue: don't cancel
    // (or release the blob the running job needs).
    const cancelled = await takePending(id);
    if (!cancelled) {
      await handleUnavailable(ctx);
      return;
    }
    await safeAnswer(ctx, 'Cancelled.');
    await safeDelete(ctx);
    if (cancelled.postDownload) {
      // release under the lock so it can't delete bytes a concurrent job for the
      // same blob is mid-upload on
      await releaseAbandoned(cancelled.info);
    }
    return;
  }

  // Confirm: anyone can confirm (unlike cancel above). The parked pending row
  // already IS a confirmed job, so adoptJob moves it into the queue with no
  // copy. A rarer adopt failure (disk error) bubbles to the callback wrapper
  // ('Something went wrong'); the claim stays clickable for a retry, and the
  // transactional claim means a later confirm still enqueues at most once.
  if (!(await adoptJob(id))) {
    await handleUnavailable(ctx); // already confirmed or cancelled
    return;
  }
  await safeAnswer(ctx, 'Starting download...');
  await safeDelete(ctx);
};

const urlRegex =
  /(http(s)?:\/\/.)?(www\.)?[-a-zA-Z0-9@:%._+~#=]{2,256}\.[a-z]{2,63}\b([-a-zA-Z0-9@:%_+.~#?&/=]*)/g;

const parseCaption = ({
  title,
  extractor,
  playlist_title,
  id,
  description,
}: any) =>
  (title === extractor && playlist_title) ||
  ((title === id || title.startsWith('Video by ')) && description) ||
  title;

const answerTooLarge = (ctx: InlineQueryContext, size?: string) => {
  const suffix = size ? ` (${size})` : '';
  return ctx.answerInlineQuery([
    {
      type: 'article',
      id: 'too-large',
      title: 'Video too large',
      description: `Too large to send${suffix}.`,
      input_message_content: {
        message_text: `Video too large to send${suffix}.`,
      },
    },
  ]);
};

// Inline queries download and upload IN-HANDLER (no durable job row), so the
// shutdown drain must count them alongside queue jobs or the process could
// exit mid-upload and simply lose the query (see bot.ts's drain hold).
let inlineInFlight = 0;
export const inlineIdle = () => inlineInFlight === 0;

export const inlineQueryHandler = async (ctx: InlineQueryContext) => {
  inlineInFlight++;
  try {
    await handleInlineQuery(ctx);
  } finally {
    inlineInFlight--;
  }
};

const handleInlineQuery = async (ctx: InlineQueryContext) => {
  let info: VideoInfo | undefined;
  try {
    // only the first URL in an inline query is handled (multi-URL unsupported)
    let url = ctx.inlineQuery.query?.match(urlRegex)?.[0];
    if (!url) return;
    url = ensureScheme(url);

    const log = new NoLog();
    info = await getInfo(log, url, false);
    url = info.webpage_url || url;
    // inline is for small clips: if the scraped size already exceeds the send
    // limit, reject up front rather than download something we can never send
    const tooLarge = tooLargeToSend(info);
    if (tooLarge) {
      await answerTooLarge(ctx, tooLarge);
      return;
    }
    // TODO: make the cache chat id configurable
    const msg = await downloadAndSend(ctx.telegram, log, info, false, -4640446184);
    // sendVideo returns undefined only when the real bytes exceeded the limit
    // (the estimate above was missing/under): tell the user, don't answer blank
    if (!msg) {
      await answerTooLarge(ctx);
      return;
    }

    const video = {
      type: 'video' as const,
      video_file_id: msg.video.file_id,
    };
    const caption = parseCaption(info);
    const src = {
      reply_markup: { inline_keyboard: [[{ text: 'Source', url }]] },
    };
    await ctx.answerInlineQuery([
      {
        id: '0',
        title: `Send video "${caption}"`,
        ...video,
        caption,
        ...src,
      },
      { id: '1', title: `Send without caption`, ...video, ...src },
      { id: '2', title: `Send without source`, ...video, caption },
      {
        id: '3',
        title: `Send without caption or source (no context)`,
        ...video,
      },
    ]);
  } catch (e: any) {
    console.error('error while handling inline query:', e);
    // evict likely-expired cached info so a later request re-scrapes
    if (info && e instanceof YtdlpError) removeCachedInfo(info);
    // no retry path here, so release any blob this failed query left behind
    if (info) await releaseAbandoned(info);
    // no parse_mode on this article, so don't HTML-escape via errMsg as the
    // chat handlers do. The sentinel's "resumes shortly" wording is a queue
    // promise; inline work has no row and dies here, so say retry instead.
    const detail =
      e instanceof ShutdownAbort
        ? 'The bot is restarting, please try again in a moment'
        : e?.message || 'An unknown error occurred';
    try {
      await ctx.answerInlineQuery([
        {
          type: 'article',
          id: 'error',
          title: 'Failed to process video',
          description: detail,
          input_message_content: {
            message_text: `Failed to process video: ${detail}`,
          },
        },
      ]);
    } catch (e2) {
      // answerInlineQuery can fail if too much time has passed
      console.error('Failed to send inline error result:', e2);
    }
  }
};
