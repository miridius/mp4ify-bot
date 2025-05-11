import { stat } from 'fs/promises';
import he from 'he';
import { LogMessage, type MessageContext } from './log-message';

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
const UPDATE_INTERVAL_MS = 1000 * 60 * 60 * 24; // 1 day
const DOWNLOAD_TIMEOUT_SECS = 60;

let lastUpdated: Date;
const shouldUpdate = () => {
  // @ts-ignore
  if (!lastUpdated || lastUpdated < new Date() - UPDATE_INTERVAL_MS) {
    lastUpdated = new Date();
    return true;
  }
};

const exists = async (path: string) => Bun.file(path).exists();

const getErrorMessage = (proc: Bun.ReadableSubprocess) =>
  proc.signalCode === 'SIGTERM'
    ? `Timed out after ${DOWNLOAD_TIMEOUT_SECS} seconds`
    : proc.signalCode
      ? `yt-dlp was killed with signal ${proc.signalCode}`
      : `yt-dlp exited with code ${proc.exitCode}`;

const downloadVideo = async (
  logMsg: LogMessage,
  url: string,
  verbose = false,
) => {
  const command = ['yt-dlp', url, verbose ? '--verbose' : '--no-warnings'];
  if (shouldUpdate()) command.push('--update');
  const proc = Bun.spawn(command, {
    stderr: 'pipe',
    timeout: DOWNLOAD_TIMEOUT_SECS * 1000,
  });

  // log stderr
  let firstLine = true;
  for await (const chunk of proc.stderr) {
    if (firstLine) {
      logMsg.append(''); // add a blank line above stderr output
      firstLine = false;
    }
    const line = new TextDecoder().decode(chunk);
    logMsg.append(`<code>${he.encode(line.trim())}</code>`);
  }

  // check for errors
  await proc.exited;
  if (proc.exitCode !== 0) throw new Error(getErrorMessage(proc));

  // parse & return the json from stdout
  return await new Response(proc.stdout).json();
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
    : format_id?.toUpperCase());

const parseCaption = ({
  title,
  extractor,
  playlist_title,
  id,
  description,
}: any) =>
  (title === extractor && playlist_title) ||
  ((title === id || extractor === 'Instagram') && description) ||
  title;

/**
 * Downloads a video using youtube-dl, returns output file path and other params
 * ready to be passed directly to telegram sendVideo
 */
export const downloadAndSendVideo = async (
  ctx: MessageContext,
  url: string,
  verbose = false,
) => {
  const logMsg = new LogMessage(ctx, `⬇️ <b>Downloading</b> ${url}...`);
  try {
    // Use youtube-dl to download the video
    const info: any = await downloadVideo(logMsg, url, verbose);
    if (verbose) console.debug('info JSON:', info);
    logFormats(info);

    const { filename, duration, width, height, vcodec, vbr, acodec, abr } =
      info;

    if (!(await exists(filename))) {
      throw new Error('ERROR: yt-dlp output file not found');
    }

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
