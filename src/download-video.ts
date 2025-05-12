import { $ } from 'bun';
import { stat, symlink } from 'fs/promises';
import he from 'he';
import type { Context } from 'telegraf';
import type { Message } from 'telegraf/types';
import { LogMessage } from './log-message';
import { memoize } from './utils';

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
const DOWNLOAD_TIMEOUT_SECS = 60;
const CACHE_DIR = './.video-cache/';
const INFO_CACHE_DIR = CACHE_DIR + 'info/';
await $`mkdir -p ${INFO_CACHE_DIR}`;

const exists = async (path: string) => Bun.file(path).exists();

const getErrorMessage = (proc: Bun.ReadableSubprocess) =>
  proc.signalCode === 'SIGTERM'
    ? `Timed out after ${DOWNLOAD_TIMEOUT_SECS} seconds`
    : proc.signalCode
      ? `yt-dlp was killed with signal ${proc.signalCode}`
      : `yt-dlp exited with code ${proc.exitCode}`;

type VideoInfo = {
  // fileId?: string;
  filename: string;
  webpage_url: string;
  duration?: number;
  width?: number;
  height?: number;
  vcodec?: string;
  vbr?: number;
  acodec?: string;
  abr?: number;
  filesize?: number;
  filesize_approx: number;
  // [x: string]: any;
};

const execYtdlp = async (
  logMsg: LogMessage,
  url: string,
  verbose: boolean,
  ...extraArgs: string[]
) => {
  const command = [
    'yt-dlp',
    url,
    verbose ? '--verbose' : '--no-warnings',
    ...extraArgs,
  ];

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

  // return stdout as a string
  return await new Response(proc.stdout).text();
};

const filenamify = (s: string) =>
  Buffer.from(s).toBase64().replaceAll('/', '_');
const urlInfoFile = (url: string) => Bun.file(INFO_CACHE_DIR + filenamify(url));

export const getInfo = memoize(
  async (
    log: LogMessage,
    url: string,
    verbose: boolean = false,
  ): Promise<VideoInfo> => {
    const infoFile = urlInfoFile(url);
    if (await infoFile.exists()) return await infoFile.json();

    const infoStr = await execYtdlp(log, url, verbose, '--dump-json');
    const info = JSON.parse(infoStr) as VideoInfo;
    const { webpage_url } = info;
    if (webpage_url && webpage_url !== url) {
      const mainInfoFile = Bun.file(INFO_CACHE_DIR + filenamify(webpage_url));
      if (!(await mainInfoFile.exists())) Bun.write(mainInfoFile, infoStr);
      await symlink(filenamify(webpage_url), infoFile.name!);
    } else {
      if (!(await infoFile.exists())) Bun.write(infoFile, infoStr);
    }
    return info;
  },
  (_log, url) => url,
);

// cached based on url
export const downloadVideo = memoize(
  async (log: LogMessage, url: string, verbose: boolean = false) =>
    execYtdlp(log, '', verbose, '--load-info-json', urlInfoFile(url).name!),
  (_log, url) => url,
);

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
  ((title === id || title.startsWith('Video by ')) && description) ||
  title;

// cached based on filename + chatId + replyToMessageId
export const sendVideo = memoize(
  async (
    ctx: Context,
    log: LogMessage,
    info: VideoInfo,
    chatId: number,
    replyToMessageId?: number,
    verbose = false,
  ): Promise<Message.VideoMessage | undefined> => {
    // Use youtube-dl to download the video
    // const info: any = await downloadVideo(logMsg, url, verbose);
    if (verbose) console.debug('info JSON:', info);
    logFormats(info);

    const { filename, duration, width, height, vcodec, vbr, acodec, abr } =
      info;
    const idFile = Bun.file(`${filename}.id`);
    const fileId = (await idFile.exists()) && (await idFile.text());

    if (!(fileId || (await exists(filename)))) {
      throw new Error('ERROR: yt-dlp output file not found');
    }

    const size = fileId
      ? info.filesize || info.filesize_approx
      : // get file size from fs
        (await stat(filename)).size;

    const caption = parseCaption(info);

    log.append('\n✅ <b>Video ready:</b>\n');

    const logInfo = (name: string, value: any) =>
      value && log.append(`<b>${name}</b>: ${value}`);

    logInfo('caption', caption && he.encode(caption));
    logInfo('duration', duration && `${Math.round(duration)} sec`);
    logInfo('size', size && `${(size / 1024 / 1024).toFixed(2)} MB`);
    logInfo('resolution', parseRes(info));
    logInfo('video codec', vcodec && `${vcodec} ${vbr ? `@ ${vbr} kbps` : ''}`);
    logInfo('audio codec', acodec && `${acodec} ${abr ? `@ ${abr} kbps` : ''}`);

    if (size > MAX_FILE_SIZE_BYTES) {
      log.append(`\n😞 Video too large (exceeds max size of 50 MB)`);
      return;
    }

    log.append('\n🚀 <b>Uploading...</b>');
    log.flush();

    const res = await ctx.telegram.sendVideo(
      chatId,
      fileId || { source: filename },
      {
        caption,
        width: width,
        height: height,
        duration: duration,
        supports_streaming: true,
        disable_notification: true,
        ...(replyToMessageId
          ? {
              reply_parameters: { message_id: replyToMessageId },
              // @ts-ignore - workaround for a bug in the telegram bot API
              reply_to_message_id: replyToMessageId,
            }
          : {}),
      },
    );
    await Bun.write(idFile, res.video.file_id);
    // await $`rm ${filename}`;
    return res;
  },
  (_ctx, _log, info, chatId, replyToMessageId) =>
    JSON.stringify([info.filename, chatId, replyToMessageId]),
);
