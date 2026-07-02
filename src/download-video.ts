import { copyFile, readdir, realpath, rename, rm, stat } from 'fs/promises';
import { basename } from 'path';
import type { Telegram } from 'telegraf';
import type { Message } from 'telegraf/types';
import {
  blobKey,
  blobPath,
  clearBlobFileId,
  getBlob,
  recordBlob,
  releaseBlob,
  setBlobDuration,
  setBlobFileId,
} from './blob-store';
import { STAGING_DIR } from './consts';
import { db, tx } from './db';
import { unlinkQuiet } from './fs-utils';
import { ShutdownAbort } from './job-queue';
import { LogMessage } from './log-message';
import { coalesce, limit, telegramDesc } from './utils';

const MAX_FILE_SIZE_BYTES = 2000 * 1024 * 1024; // 2000 MB
const DOWNLOAD_TIMEOUT_SECS = 300;
// cap the stderr we keep for error classification: a long/verbose download
// streams a lot, and we only need the tail (yt-dlp prints its ERROR last)
const STDERR_TAIL = 64 * 1024;
// Poll often so a broken extractor is fixed within minutes, not a day. Each
// poll is one unauthenticated GitHub API call (60/hr/IP, shared with prod), so
// stay well above ~2 min.
export const YTDLP_UPDATE_INTERVAL_MS = 1000 * 60 * 5;

const exists = async (path: string) => Bun.file(path).exists();

const getErrorMessage = (proc: Bun.ReadableSubprocess) =>
  proc.signalCode === 'SIGTERM'
    ? `Timed out after ${DOWNLOAD_TIMEOUT_SECS} seconds`
    : proc.signalCode
      ? `yt-dlp was killed with signal ${proc.signalCode}`
      : `yt-dlp exited with code ${proc.exitCode}`;

// carries the failing yt-dlp's stderr so callers can classify it (see
// isPermanentError)
export class YtdlpError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    // killed by a signal (timeout/OOM) rather than exiting with a code
    readonly signalled = false,
  ) {
    // yt-dlp's own ERROR: line (the last one is the fatal one) says WHY it
    // failed; the exit code alone helps nobody, so it's only the fallback.
    // A signal kill keeps its message: the timeout is the real story there,
    // and any ERROR line in a killed process's output is a stale partial.
    // De-noise for the report: drop the [extractor] tag and the "(caused
    // by ...)" suffix that repeats the main clause; the raw line still
    // streams to the chat verbatim, and classification reads raw stderr.
    const errLine = signalled
      ? undefined
      : stderr
          .split('\n')
          .findLast((line) => line.startsWith('ERROR:'))
          ?.slice('ERROR:'.length)
          .replace(/^\s*\[[^\]]+\]\s*/, '')
          .replace(/\s*\(caused by .*\)\s*$/, '')
          .trim();
    super(errLine || message);
    this.name = 'YtdlpError';
  }
}

// Failures a retry can't fix: the URL/extractor genuinely can't be handled. We
// assume the background updater keeps yt-dlp current (see updateYtdlp), so a
// fresh yt-dlp that still can't extract a URL means it's unsupported, not stale.
// Anything not listed (network blips, 5xx, 408/429, a transient fragment
// 404/403, unknown errors) is retryable: better to retry a lost cause a few
// times than drop a video a retry would have delivered. The one HTTP
// exception is a 403/404/410 on the *webpage* fetch: the URL is gone or the
// site refuses us outright, and neither changes within the retry window
// (a mid-download segment error isn't; that's why this is scoped to the webpage).
const PERMANENT_PATTERNS = [
  /unsupported url/i,
  /unable to extract/i,
  /no video formats found/i,
  /is not a valid url/i,
  /private video/i,
  /video unavailable/i,
  /no longer available/i,
  /has been removed/i,
  /members[- ]only/i,
  /sign in to confirm your age/i,
  /unable to download webpage: http error (403|404|410)\b/i,
];
// A signal kill (timeout/OOM) is always transient. For yt-dlp, match only its
// own `ERROR:` lines, not WARNINGs or echoed page text, which can contain the
// same phrases and would false-positive a retryable failure.
export const isPermanentError = (e: unknown): boolean => {
  if (e instanceof YtdlpError) {
    return (
      !e.signalled &&
      e.stderr
        .split('\n')
        .some(
          (line) =>
            line.startsWith('ERROR:') &&
            PERMANENT_PATTERNS.some((re) => re.test(line)),
        )
    );
  }
  // Telegram 403 = the user blocked the bot, or it was kicked/deactivated; a
  // few 400s name a gone chat/peer/reply-target. All are permanent-by-policy:
  // a retry of the same chat can't help (429/5xx fall through to retryable).
  const code = (e as any)?.response?.error_code;
  return (
    code === 403 ||
    (code === 400 &&
      // wordings verified against the local bot-api server, which both bots
      // run through; it reports every bad-peer variant as "chat not found"
      /chat not found|message to be replied not found/i.test(telegramDesc(e)))
  );
};

export type VideoInfo = {
  filename: string;
  title: string;
  // yt-dlp's stable per-video identity (from --dump-json); keys the blob
  // (see blobKey); `ext` names the blob file
  extractor?: string;
  id?: string;
  format_id?: string;
  ext?: string;
  description?: string;
  webpage_url?: string;
  duration?: number;
  width?: number;
  height?: number;
  vcodec?: string;
  vbr?: number;
  acodec?: string;
  abr?: number;
  tbr?: number;
  filesize?: number;
  filesize_approx?: number;
  sponsorblock_chapters?: {
    start_time: number;
    end_time: number;
    category: 'sponsor' | string;
    title: 'Sponsor' | string;
    type: 'skip' | string;
  }[];
};

// Self-update yt-dlp so extractors track site changes. Never throws: a failed
// update just keeps the current version.
//
// Our `yt-dlp` is a zipapp, whose `--update` rewrites the binary IN PLACE, not
// atomically, so a download exec'ing it mid-rewrite would get a corrupt file.
// So we update a COPY and rename it into place: running execs keep the old
// inode, new execs see old-or-new, never a partial. updateYtdlp is single-
// flight (the boot call and the timer share one in-flight run), and the atomic
// rename means no lock is needed against in-flight downloads.
export const updateYtdlp = coalesce(
  () => doUpdate(),
  () => 'yt-dlp',
);

// the live binary's own version, or null when it can't be read (a broken
// binary is exactly what an update might fix, so callers fall through to the
// full update on null rather than treating it as fatal). Cached against the
// binary's mtime: spawning the ~35MB zipapp every 5-minute tick just to
// re-read an unchanged version wastes CPU the downloads need.
let versionCache: { bin: string; mtimeMs: number; version: string } | null =
  null;
const ytdlpVersion = async (bin: string): Promise<string | null> => {
  try {
    const { mtimeMs } = await stat(bin);
    if (versionCache?.bin === bin && versionCache.mtimeMs === mtimeMs) {
      return versionCache.version;
    }
    const proc = Bun.spawn([bin, '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30_000,
    });
    liveYtdlp.add(proc); // so abortDownloads can kill it at shutdown
    let out: string;
    try {
      out = await Bun.readableStreamToText(proc.stdout);
      await proc.exited;
    } finally {
      // always drop the dead proc; a stream-read throw would otherwise leak it
      liveYtdlp.delete(proc);
    }
    const version = proc.exitCode === 0 ? out.trim() || null : null;
    // written only on success: a miss already can't serve stale (the key is
    // the exact bin+mtime), so there is no failure-invalidation protocol
    if (version) versionCache = { bin, mtimeMs, version };
    return version;
  } catch (e) {
    console.error('yt-dlp self-update: reading version failed:', e);
    return null;
  }
};

// yt-dlp's latest NIGHTLY tag (its --version output uses the same timestamped
// format, e.g. 2026.07.14.233956), or null when the check fails: the tick is
// then SKIPPED, because falling through would re-run the 35MB copy dance every
// poll for the whole outage while adding API calls that extend a rate-limit
// window. A real release waits at most one outage for the next successful
// check. Nightly, not stable: extractors for fast-moving sites (e.g. Instagram)
// break in stable and land in nightly first, and tracking those is the whole
// reason this updater exists.
const RELEASES_LATEST =
  'https://api.github.com/repos/yt-dlp/yt-dlp-nightly-builds/releases/latest';
const latestYtdlpVersion = async (): Promise<string | null> => {
  try {
    const res = await fetch(RELEASES_LATEST, {
      headers: { 'user-agent': 'mp4ify-bot' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      console.error(`yt-dlp self-update: release check got HTTP ${res.status}`);
      return null;
    }
    return ((await res.json()) as any)?.tag_name ?? null;
  } catch (e) {
    console.error('yt-dlp self-update: release check failed:', e);
    return null;
  }
};

const doUpdate = async () => {
  // don't start the copy+update dance during shutdown; unlike execYtdlp this
  // just returns (no ShutdownAbort: updateYtdlp never throws)
  if (shuttingDown) return;
  const onPath = Bun.which('yt-dlp');
  if (!onPath) {
    console.error('yt-dlp not on PATH; skipping self-update');
    return;
  }
  let live: string;
  try {
    live = await realpath(onPath);
  } catch (e) {
    console.error('yt-dlp self-update failed (resolving path):', e);
    return;
  }
  // the dev container has test/bin stubs first on PATH; "updating" the stub
  // would run --update through its delegation and rewrite the real binary in
  // place, the exact non-atomic hazard the copy+rename below exists to prevent
  if (live.includes('/test/bin/')) {
    console.debug('yt-dlp resolves to a test stub; skipping self-update');
    return;
  }

  // Cheap pre-check: `--update-to nightly` would discover "already up to date"
  // itself, but only after we've copied the ~35MB zipapp: at this poll rate
  // that's ~10GB of pointless volume writes a day. Skip the copy when the live
  // version already matches the latest nightly; if either side is unreadable,
  // fall through to the full update (liveness beats thrift).
  const [current, latest] = await Promise.all([
    ytdlpVersion(live),
    latestYtdlpVersion(),
  ]);
  if (!latest) return; // check failed; see latestYtdlpVersion
  if (current === latest) {
    console.debug('yt-dlp already up to date');
    return;
  }
  // current unreadable (null) falls through: a broken binary is exactly what
  // an update might fix

  // same dir as the live binary, so the swap is a single-volume rename;
  // copyFile preserves the source's mode, so the copy stays executable
  const temp = `${live}.${crypto.randomUUID()}.new`;
  try {
    await copyFile(live, temp);
    const before = await stat(temp);

    // --update-to nightly, not plain --update: pins the copy to the nightly
    // channel so a stable-built binary switches over and stays there
    const proc = Bun.spawn([temp, '--update-to', 'nightly'], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 120_000,
    });
    liveYtdlp.add(proc); // so abortDownloads can kill it at shutdown
    let stdout: string, stderr: string;
    try {
      [stdout, stderr] = await Promise.all([
        Bun.readableStreamToText(proc.stdout),
        Bun.readableStreamToText(proc.stderr),
      ]);
      await proc.exited;
    } finally {
      // always drop the dead proc; a stream-read throw would otherwise leak it
      liveYtdlp.delete(proc);
    }
    if (proc.exitCode !== 0) {
      console.error(
        `yt-dlp self-update failed (${proc.signalCode ?? `exit code ${proc.exitCode}`}): ${stderr.trim()}`,
      );
      return;
    }

    // require the stat unchanged too: bias toward a harmless no-op swap so a
    // reworded "up to date" string can't mask a real update
    const after = await stat(temp);
    if (
      /up to date/i.test(stdout) &&
      after.size === before.size &&
      after.mtimeMs === before.mtimeMs
    ) {
      console.debug('yt-dlp already up to date');
      return;
    }
    await rename(temp, live);
    console.log('yt-dlp self-update:', stdout.trim());
  } catch (e) {
    console.error('yt-dlp self-update failed:', e);
  } finally {
    // already renamed away on the success path (ENOENT expected); unlinkQuiet
    // logs any other failure so a leaked temp in the binary dir is visible
    await unlinkQuiet(temp);
  }
};

// One cap for every yt-dlp caller: queue jobs and in-handler inline queries
// alike, so total yt-dlp processes stay bounded. Sharing the budget means a
// burst of long downloads can make an inline query wait for a slot; that's an
// accepted trade-off (inline volume is low), not a starvation bug.
const YTDLP_CONCURRENCY = 3;

// Shutdown support (see ShutdownAbort in job-queue): downloads are the one
// abortable phase, so SIGTERM kills every live yt-dlp and refuses new spawns,
// letting the process drain to just the un-abortable sends. In-memory state,
// like the pump's; a new process starts accepting again.
const liveYtdlp = new Set<Bun.Subprocess>();
let shuttingDown = false;
export const abortDownloads = () => {
  shuttingDown = true;
  for (const proc of liveYtdlp) proc.kill();
};
// test-only: suites that exercise the shutdown path must re-arm spawning
export const resetShutdown = () => {
  shuttingDown = false;
};
// test-only accessor for liveYtdlp.size
export const liveYtdlpSize = () => liveYtdlp.size;

const execYtdlp = limit(
  YTDLP_CONCURRENCY,
  async (
    logMsg: LogMessage,
    url: string,
    verbose: boolean,
    ...extraArgs: string[]
  ) => {
    // a queued caller may win its slot only after shutdown began (killing a
    // running proc frees one); it must not start a fresh download then
    if (shuttingDown) throw new ShutdownAbort();
    const command = [
      'yt-dlp',
      url,
      verbose ? '--verbose' : '--no-warnings',
      ...extraArgs,
    ];
    console.debug(command.join(' '));

    const proc = Bun.spawn(command, {
      stderr: 'pipe',
      timeout: DOWNLOAD_TIMEOUT_SECS * 1000,
    });
    liveYtdlp.add(proc);

    // Keep stderr so a failure can be classified (permanent vs retry). One
    // streaming decoder, so a multi-byte char split across chunks isn't garbled
    // (which would both mis-render and could defeat the classifier).
    let stderr = '';
    let firstLine = true;
    const decoder = new TextDecoder();
    try {
      for await (const chunk of proc.stderr) {
        if (firstLine) {
          // visually separate the streamed stderr from the progress above it
          logMsg.append('');
          firstLine = false;
        }
        const text = decoder.decode(chunk, { stream: true });
        stderr += text;
        if (stderr.length > 2 * STDERR_TAIL) {
          // trim on a line boundary so the cut never decapitates the `ERROR:`
          // prefix that isPermanentError keys on
          const nl = stderr.indexOf('\n', stderr.length - STDERR_TAIL);
          stderr = nl === -1 ? stderr.slice(-STDERR_TAIL) : stderr.slice(nl + 1);
        }
        logMsg.append(`<code>${Bun.escapeHTML(text.trim())}</code>`);
      }
      stderr += decoder.decode(); // flush any buffered trailing bytes

      await proc.exited;
    } finally {
      liveYtdlp.delete(proc);
    }
    // our own shutdown kill, not a failure: the queue leaves the job for the
    // next boot (a timeout kill sets no flag and stays a retryable YtdlpError)
    if (shuttingDown && proc.signalCode != null) throw new ShutdownAbort();
    if (proc.exitCode !== 0)
      throw new YtdlpError(
        getErrorMessage(proc),
        stderr,
        proc.signalCode != null,
      );

    // stdout is read last, after stderr is fully drained: Bun buffers a piped
    // child's stdout, so draining stderr to EOF first can't deadlock on a full
    // stdout pipe (it would if stdout were unbuffered and left unread)
    return await Bun.readableStreamToText(proc.stdout);
  },
);

// Scraped info embeds signed media URLs that EXPIRE (YouTube's in ~6 hours),
// and downloadVideo replays them verbatim via --load-info-json, so a stale row
// isn't a cheap shortcut, it's a guaranteed download failure. Rows past the TTL
// are ignored on read (the DO UPDATE upsert refreshes them in place); the
// sweep (boot + hourly, see bot.ts) keeps the expired ones from accumulating:
// each dead row holds a full dump-json payload, easily megabytes.
const INFO_TTL_MS = 1000 * 60 * 60 * 6;
const selectInfoStmt = db.query<{ info: string }, [string, number]>(
  'SELECT info FROM video_info WHERE url = ? AND created_at > ?',
);
const insertInfoStmt = db.query<
  null,
  [string, string, string | null, number]
>(
  `INSERT INTO video_info (url, info, webpage_url, created_at) VALUES (?, ?, ?, ?)
   ON CONFLICT(url) DO UPDATE SET info = excluded.info, webpage_url = excluded.webpage_url, created_at = excluded.created_at`,
);
const sweepInfoStmt = db.query<null, [number]>(
  'DELETE FROM video_info WHERE created_at <= ?',
);
// called at boot and hourly by bot.ts (contained there: a disk-error throw
// at module load would crash boot instead of being hygiene-only)
export const sweepStaleInfo = () =>
  sweepInfoStmt.run(Date.now() - INFO_TTL_MS);

// Coalesced, not memoized: the DB row above serves repeat lookups, so keeping
// settled results in memory would only pin megabytes of dump-json per URL and
// grow stale (see INFO_TTL_MS); the in-flight entry alone stops two concurrent
// jobs from both scraping.
export const getInfo = coalesce(
  async (
    log: LogMessage,
    url: string,
    verbose: boolean = false,
  ): Promise<VideoInfo> => {
    // a verbose request bypasses the cache (like the coalesce key below) so its
    // yt-dlp output is actually streamed to the chat for debugging
    const cached = selectInfoStmt.get(url, Date.now() - INFO_TTL_MS);
    if (cached && !verbose) return JSON.parse(cached.info);

    log.append(`🧐 <b>Scraping</b> ${url}...`);

    const infoStr = await execYtdlp(log, url, verbose, '--dump-json');
    const info = JSON.parse(infoStr) as VideoInfo;
    const hadCanonical = !!info.webpage_url;
    info.webpage_url ||= url;
    // narrowed to a truthy string by the ||= above; a local const carries that
    // through the tx closure (TS drops property narrowing across the boundary)
    const canonical = info.webpage_url;
    // also key a row by the canonical webpage_url so a later alias request
    // for the same video hits the cache instead of re-scraping. Reuse
    // yt-dlp's own string when nothing changed: re-serializing a multi-MB
    // payload just to store identical content is wasted event-loop time.
    const str = hadCanonical ? infoStr : JSON.stringify(info);
    const now = Date.now();
    tx(() => {
      insertInfoStmt.run(url, str, canonical, now);
      if (canonical !== url) {
        insertInfoStmt.run(canonical, str, canonical, now);
      }
    });
    return info;
  },
  (_log, url, verbose) => !verbose && url,
);

// Evict a video's cached info (the url row and its canonical alias share one
// webpage_url) after a download failure: the likely cause is the expired signed
// URLs above, so on the retry (or the next request) getInfo must re-scrape
// rather than replay the same doomed row.
const deleteInfoStmt = db.query<null, [string]>(
  `DELETE FROM video_info WHERE webpage_url = ?`,
);
export const removeCachedInfo = (info: VideoInfo) => {
  if (info.webpage_url) deleteInfoStmt.run(info.webpage_url);
};

const logFormats = ({ formats }: any) =>
  // log all formats for debugging purposes
  formats &&
  console.table(
    formats.map(
      ({
        format,
        ext,
        vcodec,
        acodec,
        tbr,
        filesize,
        filesize_approx,
      }: any) => ({
        format,
        ext,
        vcodec,
        acodec,
        tbr,
        mb: (filesize || filesize_approx) / 1024 / 1024,
      }),
    ),
  );

const parseRes = ({ resolution, height, width, format_id }: any) =>
  resolution ||
  (height
    ? width
      ? `${width}x${height}`
      : `${height}p`
    : format_id && /\D/.test(format_id)
      ? format_id.toUpperCase()
      : undefined);

const formatSize = (size: number) => `${(size / 1024 / 1024).toFixed(2)} MB`;

// pre-download size gate from scraped metadata: a human size string if the
// video is already too big to send, else undefined (sendVideo still gates on the
// real on-disk size after download, for when the estimate is missing/wrong)
export const tooLargeToSend = (info: VideoInfo): string | undefined => {
  const size = info.filesize || info.filesize_approx;
  return size && size > MAX_FILE_SIZE_BYTES ? formatSize(size) : undefined;
};

// the user-facing "too large" line, single-sourced so the wording stays in sync
// across its chat report sites (sendVideo below; processUrlJob/processConfirmedJob
// in handlers). Pass the size string when we have it, omit it when we don't.
export const tooLargeMessage = (size?: string) =>
  size ? `😞 Video too large (${size})` : '😞 Video too large to send.';

const skippedTime = ({ sponsorblock_chapters }: VideoInfo) =>
  sponsorblock_chapters
    ?.filter(({ type }) => type === 'skip')
    .map(({ start_time, end_time }) => end_time - start_time)
    .reduce((sum, time) => sum + time, 0) || 0;

export const calcDuration = (info: VideoInfo) =>
  info.duration && Math.round(info.duration - skippedTime(info));

export const probeDuration = async (
  filename: string,
): Promise<number | undefined> => {
  // an already-uploaded blob has its bytes disposed (only the file_id remains),
  // so there is nothing to measure: return undefined quietly rather than spawn
  // ffprobe against a missing file and log a spurious failure
  if (!(await exists(filename))) return undefined;
  const proc = Bun.spawn(
    [
      'ffprobe',
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'csv=p=0',
      filename,
    ],
    // bounded: this runs under the per-blob lock, so a hung ffprobe would
    // wedge that video forever
    { stderr: 'pipe', timeout: 30_000 },
  );
  // register so abortDownloads() kills a running probe at shutdown instead of
  // it holding the loop for up to its 30s timeout; a killed probe exits
  // non-zero and we return undefined for that below (like ytdlpVersion/doUpdate)
  liveYtdlp.add(proc);
  let stdout: string, stderr: string;
  try {
    [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
  } finally {
    liveYtdlp.delete(proc);
  }
  // our own shutdown kill, not a failure: the kill was ours, so stay quiet; the
  // next boot's backfill re-probes while the bytes remain (no ShutdownAbort:
  // callers treat undefined as probe-unavailable, which is right mid-drain)
  if (shuttingDown && proc.signalCode != null) return undefined;
  if (proc.exitCode !== 0) {
    console.error(
      `ffprobe failed for ${filename} (exit ${proc.exitCode}): ${stderr.trim()}`,
    );
    return undefined;
  }
  const duration = parseFloat(stdout.trim());
  return isNaN(duration) ? undefined : Math.round(duration);
};

export const sendInfo = async (
  log: LogMessage,
  info: VideoInfo,
  verbose = false,
) => {
  if (verbose) console.debug('info JSON:', info);
  logFormats(info);

  log.append('\n🎬 <b>Video info:</b>\n');

  const { duration, filesize, filesize_approx, vcodec, vbr, acodec, abr, tbr } =
    info;
  const newDuration = calcDuration(info);

  // values are scraped metadata (titles leak into filenames): escape them or
  // a stray '<' breaks the whole chunk's HTML for every edit after it
  const logInfo = (name: string, value: any) =>
    value && log.append(`<b>${name}</b>: ${Bun.escapeHTML(String(value))}`);

  logInfo('URL', info.webpage_url);
  logInfo('filename', basename(info.filename));
  if (newDuration && newDuration < Math.round(duration!)) {
    logInfo(
      'duration',
      `${newDuration} sec (${Math.round(duration!)}s before removing sponsors)`,
    );
  } else {
    logInfo('duration', duration && `${Math.round(duration)} sec`);
  }
  // tbr is in kilobits/second, so bytes = duration(s) * tbr * 1000 / 8
  const size =
    filesize ||
    filesize_approx ||
    (duration && tbr && (duration * tbr * 1000) / 8);
  logInfo('size', size && `${formatSize(size)}`);
  logInfo('resolution', parseRes(info));
  logInfo('video codec', vcodec && `${vcodec} ${vbr ? `@ ${vbr} kbps` : ''}`);
  logInfo('audio codec', acodec && `${acodec} ${abr ? `@ ${abr} kbps` : ''}`);
};

export const isDownloaded = async (info: VideoInfo): Promise<boolean> => {
  const blob = getBlob(info);
  if (!blob) return false;
  return !!blob.file_id || (await exists(blob.path));
};

// The produced file is wherever yt-dlp put it under the download's private
// staging home: locate it rather than trusting info.filename, whose embedded
// path was computed at scrape time under whatever home THAT era's config used
// (replaying it would break on any config change).
const findProduced = async (dir: string): Promise<string> => {
  const files: string[] = [];
  for (const name of await readdir(dir, { recursive: true })) {
    // some options write metadata/partial sidecars into the home path
    if (name.endsWith('.json') || name.endsWith('.part')) continue;
    const p = `${dir}/${name}`;
    if ((await stat(p)).isFile()) files.push(p);
  }
  if (files.length !== 1) {
    throw new Error(
      `ERROR: expected one downloaded file under ${dir}, found ${files.length}`,
    );
  }
  return files[0]!;
};

// Coalesced, not memoized: isDownloaded (the blobs row) already answers "have
// we got it?" for repeat calls, so a settled memo entry could only ever replay
// a stale answer after the bytes were released, a bug class this design
// removes outright. The in-flight entry alone stops two concurrent jobs from
// both spawning yt-dlp for one video.
export const downloadVideo = coalesce(
  async (log: LogMessage, info: VideoInfo, verbose: boolean = false) => {
    if (await isDownloaded(info)) {
      return 'already downloaded';
    }
    log.append(`\n⬇️ <b>Downloading...</b>`);
    const path = blobPath(info);
    // yt-dlp wants the scraped info on disk for --load-info-json; the DB holds
    // it now, so stage a temp copy next to the blob (overwrite-safe, cleaned up)
    const infoJson = `${path}.json`;
    await Bun.write(infoJson, JSON.stringify(info));
    // A unique staging home per download: two DIFFERENT videos can share a
    // title-derived template path, so a shared home would let concurrent
    // downloads clobber each other's output file
    const staging = `${STAGING_DIR}/${crypto.randomUUID()}`;
    try {
      const out = await execYtdlp(
        log,
        '',
        verbose,
        '--paths',
        `home:${staging}`,
        '--load-info-json',
        infoJson,
      );
      await rename(await findProduced(staging), path);
      recordBlob(info);
      // probe the real duration while the bytes are guaranteed present and
      // store it on the row: scraped metadata can lack duration, and once the
      // bytes are disposed after upload there is nothing left to measure.
      // This is what keeps the long-video gate working on a file_id-only cache hit
      const duration = await probeDuration(path);
      if (duration) setBlobDuration(info, duration);
      return out;
    } finally {
      await rm(staging, { recursive: true, force: true });
      await unlinkQuiet(infoJson);
    }
  },
  (_log, info, verbose) => !verbose && blobKey(info),
);

// Returns the sent Message, or `undefined` when the real on-disk bytes exceed
// the limit (it logs + discards them first). Callers key on that `undefined` to
// report "too large" (see inlineQueryHandler, processConfirmedJob); a non-NoLog
// caller also sees the log.append below.
// Not memoized: withBlobLock serializes concurrent sends of the same video and
// the blobs.file_id cache handles reuse, so a memo would only ever cache a stale
// result (e.g. an over-size `undefined`) across requests.
export const sendVideo = async (
  telegram: Telegram,
  log: LogMessage,
  info: VideoInfo,
  chatId: number,
  replyToMessageId?: number,
): Promise<Message.VideoMessage | undefined> => {
  const { width, height } = info;
  const duration = calcDuration(info);
  const blob = getBlob(info);
  const fileId = blob?.file_id || undefined;
  const path = blob?.path ?? blobPath(info);

  if (!fileId) {
    if (!(await exists(path))) {
      throw new Error('ERROR: yt-dlp output file not found');
    }
    const size = (await stat(path)).size;

    if (size > MAX_FILE_SIZE_BYTES) {
      log.append(`\n${tooLargeMessage(formatSize(size))}`);
      // we will never send these bytes, so drop them now: nothing else will
      // (the job completes "successfully", so no catch releases them)
      await releaseBlob(info);
      return;
    }

    log.append(`\n🚀 <b>Uploading (${formatSize(size)})...</b>`);
  }
  await log.flush();

  let res: Message.VideoMessage;
  try {
    res = await telegram.sendVideo(
      chatId,
      fileId || Bun.pathToFileURL(path).href,
      {
        width,
        height,
        duration,
        supports_streaming: true,
        disable_notification: true,
        ...(replyToMessageId != undefined
          ? {
              reply_parameters: { message_id: replyToMessageId },
              // @ts-ignore - workaround for a bug in the telegram bot API
              reply_to_message_id: replyToMessageId,
            }
          : {}),
      },
    );
  } catch (e: any) {
    // the cached file_id no longer resolves (e.g. the bot-api server's data
    // was recreated): clear it so the retry re-downloads, instead of every
    // future request failing on the same dead id forever. Wording verified
    // against the real server.
    if (fileId && /wrong (remote )?file identifier/i.test(telegramDesc(e))) {
      clearBlobFileId(info);
    }
    throw e;
  }
  if (!fileId) {
    // a rejection here would mark the job retryable and re-send the
    // already-uploaded video, so swallow post-send cleanup failures.
    try {
      setBlobFileId(info, res.video.file_id);
      await unlinkQuiet(path);
    } catch (e) {
      console.error('Post-send cleanup failed (video already sent):', e);
    }
  }
  return res;
};
