import filenamify from 'filenamify';
import { rename, rm, stat } from 'fs/promises';
import he from 'he';
import { tmpdir } from 'os';
import youtubedl from 'youtube-dl-exec';
import { LogMessage, reply, type MessageContext } from './log-message';

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
const UPDATE_INTERVAL_MS = 1000 * 60 * 60 * 24; // 1 day
const DOWNLOAD_TIMEOUT_MS = 60 * 1000; // 1 minute
const SPAWN_OPTS = { timeout: DOWNLOAD_TIMEOUT_MS };

const isDev = process.env.NODE_ENV !== 'production';

let lastUpdated: Date;
const shouldUpdate = () => {
  // @ts-ignore
  if (!lastUpdated || lastUpdated < new Date() - UPDATE_INTERVAL_MS) {
    lastUpdated = new Date();
    return true;
  }
};

const exists = async (path: string) => Bun.file(path).exists();

type YtdlError = Error & {
  stdout: string;
  stderr: string;
  originalMessage: string;
};

const getErrorMessage = (
  url: string,
  { stderr, originalMessage, message }: YtdlError,
) => {
  if (
    originalMessage === 'Timed out' ||
    message.includes("signal: 'SIGTERM'")
  ) {
    return `Timed out after ${DOWNLOAD_TIMEOUT_MS} ms`;
  }
  if (stderr?.includes('requested format not available')) {
    return `Video too large (> 50 MB) or no supported formats available: ${url}`;
  } else if (stderr?.includes('Unable to extract video url')) {
    return `Unable to extract video url from ${url}.`;
  } else {
    return stderr?.match(/ERROR: (.*)/)?.[1] || originalMessage || message;
  }
};

// Return an output path in the temp directory based on the current timestamp
const uniqueTempDir = () =>
  tmpdir() +
  '/' +
  Date.now().toString(36) +
  Math.random().toString(36).slice(2, 6);

const vOpts = '[vcodec!^=?av01]';
// const vOpts = '[ext=mp4][vcodec!^=?av01]';
const gif = '[ext=gif][filesize<?50M]';
const format =
  [4, 8, 16, 25]
    .map(
      (audioSize) =>
        `bestvideo${vOpts}[filesize<?${50 - audioSize}M]` +
        `+bestaudio[filesize<?${audioSize}M]`,
    )
    .join('/') + `/best${vOpts}[filesize<?50M]/${gif}`;

const logVerboseOutput = (
  ctx: MessageContext,
  { stdout, stderr }: { stdout: string; stderr: string },
) => {
  if (stdout) reply(ctx, `<b>stdout:</b>\n${he.encode(stdout)}`);
  if (stderr) reply(ctx, `<b>stderr:</b>\n${he.encode(stderr)}`);
};

const downloadVideo = async (
  ctx: MessageContext,
  url: string,
  outputPath: string,
  verbose = false,
) => {
  try {
    const result = await youtubedl.exec(
      url,
      {
        format,
        output: outputPath,
        writeInfoJson: true,
        noProgress: true,
        mergeOutputFormat: 'mp4',
        recodeVideo: 'mp4',
        verbose: verbose || undefined,
        update: shouldUpdate(),
      },
      SPAWN_OPTS,
    );
    if (verbose) logVerboseOutput(ctx, result);
  } catch (e: any) {
    console.error(e);
    if (verbose) logVerboseOutput(ctx, e as YtdlError);
    throw new Error(getErrorMessage(url, e as YtdlError));
  }

  if (!(await exists(outputPath)))
    throw new Error('ERROR: yt-dlp output file not found');
};

const logFormats = ({ formats }: any) => {
  // log all formats for debugging purposes
  console.table(
    formats.map(
      ({
        format,
        ext,
        vcodec,
        vbr,
        acodec,
        abr,
        filesize,
        filesize_approx,
      }: any) => ({
        format,
        ext,
        vcodec,
        vbr,
        acodec,
        abr,
        mb: (filesize || filesize_approx) / 1024 / 1024,
      }),
    ),
  );
};

const parseRes = ({ resolution, height, width, format_id }: any) =>
  resolution ||
  (height
    ? width
      ? `${width}x${height}`
      : `${height}p`
    : format_id?.toUpperCase());

/**
 * Downloads a video using youtube-dl, returns output file path and other params
 * ready to be passed directly to telegram sendVideo
 */
export const downloadAndSendVideo = async (
  ctx: MessageContext,
  url: string,
  verbose = false,
) => {
  const logMsg = new LogMessage(ctx, `⬇️ <b>Downloading</b> ${url}`);
  const dir = uniqueTempDir();
  const path = `${dir}/video.mp4`;
  const infoJson = `${dir}/video.info.json`;
  console.debug({ dir, path, infoJson });
  try {
    // Use youtube-dl to download the video
    await downloadVideo(ctx, url, path, verbose);

    // Load info from json
    const info = require(infoJson);
    if (verbose) console.debug('info JSON:', info);
    logFormats(info);
    info.resolution = parseRes(info);
    if (info.title === info.extractor && info.playlist_title) {
      info.title = info.playlist_title;
    }
    if (info.title === info.id) info.title = undefined;
    if (info.description && info.title.startsWith('Video by '))
      info.title = info.description;

    // rename the file to something more sensible before upload
    const video = `${dir}/${filenamify(info.title || info.id, {
      replacement: '_',
      maxLength: 100,
    }).replace(/#/g, '_')}.mp4`;
    await rename(path, video);

    // get file size from fs
    const { size } = await stat(video);
    info.size = size;

    logMsg.append('\n✅ <b>Video ready:</b>\n');
    const logInfo = (key: string, xform = (x: any) => x, name?: string) =>
      info[key] && logMsg.append(`<b>${name || key}</b>: ${xform(info[key])}`);

    logInfo('title', he.encode);
    logInfo('duration', (d) => `${Math.round(d)} sec`);
    logInfo('size', (s) => `${(s / 1024 / 1024).toFixed(2)} MB`);
    logInfo('resolution');
    logInfo(
      'vcodec',
      (v) => `${v} ${info.vbr ? `@ ${info.vbr} kbps` : ''}`,
      'video codec',
    );
    logInfo(
      'acodec',
      (a) => `${a} ${info.abr ? `@ ${info.abr} kbps` : ''}`,
      'audio codec',
    );

    if (info.size > MAX_FILE_SIZE_BYTES) {
      logMsg.append(`\n😞 Video too large (exceeds max size of 50 MB)`);
      return;
    }

    logMsg.append('\n🚀 <b>Uploading...</b>');
    await ctx.telegram.sendVideo(
      ctx.chat.id,
      { source: video },
      {
        reply_parameters: { message_id: ctx.message.message_id },
        // @ts-ignore - workaround for a bug in the telegram bot API
        reply_to_message_id: ctx.message.message_id,
        caption: info.title,
        width: info.width,
        height: info.height,
        duration: info.duration,
        supports_streaming: true,
        disable_notification: true,
      },
    );

    return {
      video,
    };
  } catch (e: any) {
    console.error(e);
    logMsg.append(`\n💥 <b>Download failed</b>: ${he.encode(e.message)}`);
  } finally {
    // make sure the log message is fully sent
    await logMsg.flush();
    // clean up the files to save space
    if (!isDev) await rm(dir, { recursive: true, force: true });
  }
};
