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

const sized = (format: string, mb = 50) =>
  `(${format}[filesize<${mb}M]/${format}[filesize_approx<${mb}M])`;

const format =
  '(' +
  [4, 8, 16, 25]
    .map((audioMb) => `${sized('bv*', 50 - audioMb)}+${sized('ba', audioMb)}`)
    .concat(sized('best'), sized('[ext=gif]'))
    .join('/') +
  ')[vcodec!^=?av01]';

const downloadVideo = async (
  ctx: MessageContext,
  url: string,
  verbose = false,
) => {
  try {
    const { stdout, stderr } = await youtubedl.exec(
      url,
      {
        format,
        mergeOutputFormat: 'mp4',
        recodeVideo: 'mp4',
        verbose: verbose || undefined,
        update: shouldUpdate(),
        maxFilesize: '50M',
        // @ts-ignore - this flag exists but is not in the types
        paths: ['temp:/tmp', 'home:./videos'],
        output: '%(extractor)s/%(title)s-[%(id)s].%(format_id)s.%(ext)s',
        restrictFilenames: true,
        dumpJson: true,
        simulate: false,
        videoMultistreams: false,
      },
      SPAWN_OPTS,
    );
    if (stderr) {
      console.debug(stderr);
      if (verbose) await reply(ctx, `<b>logs:</b>\n${he.encode(stderr)}`);
    }
    return JSON.parse(stdout);
  } catch (e: any) {
    console.error('error:', e);
    if (verbose && e.stderr)
      await reply(ctx, `<b>logs:</b>\n${he.encode(e.stderr)}`);
    throw new Error(getErrorMessage(url, e as YtdlError));
  }
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

const parseRes = ({ resolution, height, width, format_id }: any) =>
  resolution ||
  (height
    ? width
      ? `${width}x${height}`
      : `${height}p`
    : format_id?.toUpperCase());

const parseCaption = ({
  title,
  extractor,
  playlist_title,
  id,
  description,
}: any) =>
  (title === extractor && playlist_title) ||
  (title && title !== id && !['twitter', 'Instagram'].includes(extractor)
    ? title
    : description || title);

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
  try {
    // Use youtube-dl to download the video
    const info = await downloadVideo(ctx, url, verbose);
    if (verbose) console.debug('info JSON:', info);
    logFormats(info);
    const { filename, duration, width, height, vcodec, vbr, acodec, abr } =
      info;
    console.log({
      filename,
      duration,
      width,
      height,
      vcodec,
      vbr,
      acodec,
      abr,
    });

    if (!(await exists(filename)))
      throw new Error('ERROR: yt-dlp output file not found');

    // get file size from fs
    const { size } = await stat(filename);

    const caption = parseCaption(info);

    logMsg.append('\n✅ <b>Video ready:</b>\n');

    const logInfo = (name: string, value: any) =>
      value && logMsg.append(`<b>${name}</b>: ${value}`);

    logInfo('caption', caption && he.encode(caption));
    logInfo('duration', duration && `${Math.round(duration)} sec`);
    logInfo('size', size && `${(size / 1024 / 1024).toFixed(2)} MB`);
    logInfo('resolution', parseRes(info));
    logInfo('video codec', vcodec && `${vcodec} ${vbr ? `@ ${vbr} kbps` : ''}`);
    logInfo('audio codec', acodec && `${acodec} ${abr ? `@ ${abr} kbps` : ''}`);

    if (size > MAX_FILE_SIZE_BYTES) {
      logMsg.append(`\n😞 Video too large (exceeds max size of 50 MB)`);
      return;
    }

    logMsg.append('\n🚀 <b>Uploading...</b>');
    await Promise.all([
      logMsg.flush(),
      ctx.telegram.sendVideo(
        ctx.chat.id,
        { source: filename },
        {
          reply_parameters: { message_id: ctx.message.message_id },
          // @ts-ignore - workaround for a bug in the telegram bot API
          reply_to_message_id: ctx.message.message_id,
          caption: caption,
          width: width,
          height: height,
          duration: duration,
          supports_streaming: true,
          disable_notification: true,
        },
      ),
    ]);
  } catch (e: any) {
    console.error(e);
    logMsg.append(`\n💥 <b>Download failed</b>: ${he.encode(e.message)}`);
    await logMsg.flush();
  }
};
