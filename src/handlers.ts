import { unlink } from 'fs/promises';
import type { Telegram } from 'telegraf';
import {
  calcDuration,
  downloadVideo,
  getInfo,
  probeDuration,
  sendInfo,
  sendVideo,
  type VideoInfo,
} from './download-video';
import { enqueueJob, type ConfirmedJob, type Job, type UrlJob } from './job-queue';
import { LogMessage, NoLog } from './log-message';
import {
  addPending,
  LONG_VIDEO_THRESHOLD_SECS,
  putPending,
  takePending,
} from './pending-downloads';
import type {
  CallbackQueryContext,
  InlineQueryContext,
  MessageContext,
} from './types';

const ensureScheme = (url: string) =>
  url.toLowerCase().startsWith('http') ? url : `https://${url}`;

export const textMessageHandler = async (ctx: MessageContext) => {
  const { text, chat, entities, message_id, from } =
    ctx.message || ctx.editedMessage;
  console.debug('got message:', text);
  const verbose = chat.type === 'private' && text.startsWith('/verbose ');

  await Promise.all(
    entities
      ?.filter((e) => e.type === 'url')
      .map((e) => text.slice(e.offset, e.offset + e.length))
      .map(async (url) => {
        try {
          await enqueueJob({
            kind: 'url',
            url: ensureScheme(url),
            chatId: chat.id,
            chatType: chat.type,
            messageId: message_id,
            fromId: from?.id ?? 0,
            verbose,
          });
        } catch (e: any) {
          console.error('Failed to enqueue download:', e);
          await ctx.telegram
            .sendMessage(chat.id, `💥 <b>Download failed</b>: ${errMsg(e)}`, {
              reply_parameters: { message_id },
              parse_mode: 'HTML',
            })
            .catch((notifyErr) =>
              console.error('Failed to report the error to the user:', notifyErr),
            );
        }
      }) || [],
  );
};

export const processJob = async (telegram: Telegram, me: string, job: Job) =>
  job.kind === 'url'
    ? processUrlJob(telegram, me, job)
    : processConfirmedJob(telegram, me, job);

const processUrlJob = async (telegram: Telegram, me: string, job: UrlJob) => {
  const { url, chatId, chatType, messageId, verbose } = job;
  const log = new LogMessage(telegram, {
    chatId,
    chatType,
    replyTo: messageId,
  });
  try {
    const info = await getInfo(log, url, verbose);
    await sendInfo(log, info, verbose);
    const duration = calcDuration(info);
    const isGroupChat = chatType !== 'private';
    if (isGroupChat && duration && duration > LONG_VIDEO_THRESHOLD_SECS) {
      await requestConfirmation(telegram, job, info);
      return;
    }
    console.debug(await downloadVideo(me, log, info, verbose));
    if (isGroupChat) {
      const actualDuration = await probeDuration(info.filename);
      if (actualDuration && actualDuration > LONG_VIDEO_THRESHOLD_SECS) {
        const infoWithDuration = { ...info, duration: actualDuration };
        await requestConfirmation(telegram, job, infoWithDuration, true);
        return;
      }
    }
    await sendVideo(telegram, me, log, info, chatId, messageId);
  } catch (e: any) {
    // log first: reporting to the user can itself fail
    console.error(e);
    try {
      log.append(`\n💥 <b>Download failed</b>: ${errMsg(e)}`);
      await log.flush();
    } catch (notifyErr) {
      console.error('Failed to report the error to the user:', notifyErr);
    }
  }
};

const processConfirmedJob = async (
  telegram: Telegram,
  me: string,
  job: ConfirmedJob,
) => {
  const { info, chatId, messageId, verbose, postDownload } = job;
  const log = new NoLog();
  try {
    if (!postDownload) {
      console.debug(await downloadVideo(me, log, info, verbose));
    }
    await sendVideo(telegram, me, log, info, chatId, messageId);
  } catch (e: any) {
    console.error('Download failed after confirmation:', e);
    try {
      await telegram.sendMessage(
        chatId,
        `💥 <b>Download failed</b>: ${errMsg(e)}`,
        {
          reply_parameters: { message_id: messageId },
          parse_mode: 'HTML',
        },
      );
    } catch (sendErr: any) {
      console.error('Failed to send error message:', sendErr);
    }
  }
};

const errMsg = (e: any) => Bun.escapeHTML(e?.message || String(e));

const formatDuration = (secs: number) => {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
};

const requestConfirmation = async (
  telegram: Telegram,
  job: UrlJob,
  info: VideoInfo,
  postDownload: boolean = false,
) => {
  const duration = calcDuration(info)!;

  const id = await addPending({
    info,
    verbose: job.verbose,
    messageId: job.messageId,
    chatId: job.chatId,
    userId: job.fromId,
    postDownload,
  });

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
};

const safeAnswer = (ctx: CallbackQueryContext, text: string) =>
  ctx.answerCbQuery(text).catch((e) => console.error('answerCbQuery failed:', e));

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

  // Cancel: only the original requester can cancel
  if (action === 'no') {
    const pending = await takePending(id);
    if (!pending) {
      await handleUnavailable(ctx);
      return;
    }
    if (ctx.from!.id !== pending.userId) {
      await putPending(id, pending);
      await safeAnswer(ctx, 'Only the requester can cancel.');
      return;
    }
    await safeAnswer(ctx, 'Cancelled.');
    await safeDelete(ctx);
    if (pending.postDownload) {
      try {
        await unlink(pending.info.filename);
      } catch (e: any) {
        if (e.code !== 'ENOENT') {
          console.error(`Failed to clean up ${pending.info.filename}:`, e);
        }
      }
    }
    return;
  }

  // Confirm: anyone can confirm
  const pending = await takePending(id);
  if (!pending) {
    await handleUnavailable(ctx);
    return;
  }
  try {
    const { userId: _userId, ...job } = pending;
    await enqueueJob({ kind: 'confirmed', ...job });
  } catch (e) {
    // the claim must not be lost: restore it so the button works again
    await putPending(id, pending);
    throw e;
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

export const inlineQueryHandler = async (ctx: InlineQueryContext) => {
  try {
    // multiple inline URLs are not supported (currently), so just grab the first one we find
    let url = ctx.inlineQuery.query?.match(urlRegex)?.[0];
    if (!url) return;
    url = ensureScheme(url);

    const log = new NoLog();
    const info = await getInfo(log, url, false);
    url = info.webpage_url || url;
    console.debug(await downloadVideo(ctx.me, log, info, false));
    const msg = await sendVideo(ctx.telegram, ctx.me, log, info, -4640446184); // TODO: make the cache chat id configurable
    if (!msg) return;

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
    try {
      await ctx.answerInlineQuery([
        {
          type: 'article',
          id: 'error',
          title: 'Failed to process video',
          description: e.message || 'An unknown error occurred',
          input_message_content: {
            message_text: `Failed to process video: ${e.message}`,
          },
        },
      ]);
    } catch (e2) {
      // answerInlineQuery can fail if too much time has passed
      console.error('Failed to send inline error result:', e2);
    }
  }
};
