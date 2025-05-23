import { $ } from 'bun';
import { stat, symlink } from 'fs/promises';
import { basename } from 'path';
import type { Context } from 'telegraf';
import type { Message } from 'telegraf/types';
import { LogMessage } from './log-message';
import { memoize } from './utils';

const MAX_FILE_SIZE_BYTES = 2000 * 1024 * 1024; // 2000 MB
const DOWNLOAD_TIMEOUT_SECS = 300;
const INFO_CACHE_DIR = '/storage/_video-info/';
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
  title: string;
  description?: string;
  webpage_url: string;
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
    logMsg.append(`<code>${Bun.escapeHTML(line.trim())}</code>`);
  }

  // check for errors
  await proc.exited;
  if (proc.exitCode !== 0) throw new Error(getErrorMessage(proc));

  // return stdout as a string
  return await Bun.readableStreamToText(proc.stdout);
};

const filenamify = (s: string) =>
  new Bun.CryptoHasher('sha256')
    .update(s)
    .digest('base64')
    .slice(0, -1) // remove trailing = as it provides no extra information
    .replaceAll('/', '_'); // / is not allowed in filenames, use _ instead
const urlInfoFile = (url: string) => Bun.file(INFO_CACHE_DIR + filenamify(url));

export const getInfo = memoize(
  async (
    log: LogMessage,
    url: string,
    verbose: boolean = false,
  ): Promise<VideoInfo> => {
    const infoFile = urlInfoFile(url);
    if (await infoFile.exists()) return await infoFile.json();

    log.append(`🧐 <b>Scraping</b> ${url}...`);

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
  (_log, url, verbose) => !verbose && url,
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

const formatSize = (size: number) => `${(size / 1024 / 1024).toFixed(2)} MB`;

const skippedTime = ({ sponsorblock_chapters }: VideoInfo) =>
  sponsorblock_chapters
    ?.filter(({ type }) => type === 'skip')
    .map(({ start_time, end_time }) => end_time - start_time)
    .reduce((sum, time) => sum + time) || 0;

const calcDuration = (info: VideoInfo) =>
  info.duration && Math.round(info.duration - skippedTime(info));

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

  const logInfo = (name: string, value: any) =>
    value && log.append(`<b>${name}</b>: ${value}`);

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
  const size =
    filesize || filesize_approx || (duration && tbr && duration * tbr);
  logInfo('size', size && `${formatSize(size)}`);
  logInfo('resolution', parseRes(info));
  logInfo('video codec', vcodec && `${vcodec} ${vbr ? `@ ${vbr} kbps` : ''}`);
  logInfo('audio codec', acodec && `${acodec} ${abr ? `@ ${abr} kbps` : ''}`);
};

const isDownloaded = async (ctx: Context, { filename }: VideoInfo) =>
  (await exists(`${filename}.${ctx.me}.id`)) || (await exists(filename));

// cached based on url
export const downloadVideo = memoize(
  async (
    ctx: Context,
    log: LogMessage,
    info: VideoInfo,
    verbose: boolean = false,
  ) => {
    if (await isDownloaded(ctx, info)) {
      return 'already downloaded';
    } else {
      log.append(`\n⬇️ <b>Downloading...</b>`);
      return await execYtdlp(
        log,
        '',
        verbose,
        '--load-info-json',
        urlInfoFile(info.webpage_url).name!,
      );
    }
  },
  (_ctx, _log, { filename }, verbose) => !verbose && filename,
);

// cached based on filename + chatId + replyToMessageId
export const sendVideo = memoize(
  async (
    ctx: Context,
    log: LogMessage,
    info: VideoInfo,
    chatId: number,
    replyToMessageId?: number,
  ): Promise<Message.VideoMessage | undefined> => {
    const { filename, width, height } = info;
    const duration = calcDuration(info);
    const idFile = Bun.file(`${filename}.${ctx.me}.id`);
    const fileId = (await idFile.exists()) && (await idFile.text());

    if (!fileId) {
      if (!(await exists(filename))) {
        throw new Error('ERROR: yt-dlp output file not found');
      }
      // get real file size from fs
      const size = (await stat(filename)).size;

      if (size > MAX_FILE_SIZE_BYTES) {
        log.append(`\n😞 Video too large (${formatSize(size)})`);
        return;
      }

      log.append(`\n🚀 <b>Uploading (${formatSize(size)})...</b>`);
    }
    await log.flush();

    const res = await ctx.telegram.sendVideo(
      chatId,
      fileId || 'file:/' + filename,
      {
        width,
        height,
        duration,
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
    if (!fileId) {
      await Bun.write(idFile, res.video.file_id);
      await $`rm ${filename}`;
    }
    return res;
  },
  (_ctx, _log, info, chatId, replyToMessageId) =>
    JSON.stringify([info.filename, chatId, replyToMessageId]),
);
