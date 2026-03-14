import { unlink } from 'fs/promises';
import {
  calcDuration,
  downloadVideo,
  getInfo,
  probeDuration,
  sendInfo,
  sendVideo,
  type VideoInfo,
} from './download-video';
import { LogMessage, NoLog } from './log-message';
import { isNewsUrl } from './news-detection';
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

export const textMessageHandler = async (ctx: MessageContext) => {
  const { text, chat, entities, message_id } = ctx.message || ctx.editedMessage;
  console.debug('got message:', text);
  const verbose = chat.type === 'private' && text.startsWith('/verbose ');

  // Handle all URLs in the message concurrently
  await Promise.all(
    entities
      ?.filter((e) => e.type === 'url')
      .map((e) => text.slice(e.offset, e.offset + e.length))
      .map(async (url) => {
        url = url.toLowerCase().startsWith('http') ? url : `https://${url}`;
        const log = new LogMessage(ctx);
        try {
          const info = await getInfo(log, url, verbose);
          await sendInfo(log, info, verbose);
          const duration = calcDuration(info);
          const isGroupChat = chat.type !== 'private';
          if (isGroupChat && isNewsUrl(info.webpage_url || url, info.extractor)) {
            await requestConfirmation(
              ctx, info, verbose, message_id, false,
              'This looks like a news article. Post the embedded video?',
            );
            return;
          }
          if (isGroupChat && duration && duration > LONG_VIDEO_THRESHOLD_SECS) {
            await requestConfirmation(ctx, info, verbose, message_id);
            return;
          }
          console.debug(await downloadVideo(ctx, log, info, verbose));
          // Post-download duration check for group chats
          if (isGroupChat) {
            const actualDuration = await probeDuration(info.filename);
            if (actualDuration && actualDuration > LONG_VIDEO_THRESHOLD_SECS) {
              const infoWithDuration = { ...info, duration: actualDuration };
              await requestConfirmation(ctx, infoWithDuration, verbose, message_id, true);
              return;
            }
          }
          await sendVideo(ctx, log, info, ctx.chat.id, message_id);
        } catch (e: any) {
          log.append(
            `\n💥 <b>Download failed</b>: ${Bun.escapeHTML(e.message)}`,
          );
          await log.flush();
          console.error(e);
        }
      }) || [],
  );
};

const formatDuration = (secs: number) => {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
};

const requestConfirmation = async (
  ctx: MessageContext,
  info: VideoInfo,
  verbose: boolean,
  messageId: number,
  postDownload: boolean = false,
  message?: string,
) => {
  const id = await addPending({
    info,
    verbose,
    messageId,
    chatId: ctx.chat!.id,
    userId: (ctx.message || ctx.editedMessage).from!.id,
    postDownload,
  });

  const text = message ?? (() => {
    const duration = calcDuration(info)!;
    return `This video is pretty long (${formatDuration(duration)}), do you want me to download it anyway?`;
  })();

  await ctx.telegram.sendMessage(
    ctx.chat!.id,
    text,
    {
      reply_parameters: { message_id: messageId },
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
  const data = (ctx.callbackQuery as any).data as string | undefined;
  if (!data) return;

  const match = data.match(/^(dl|no):([a-z0-9-]+)$/);
  if (!match) {
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
  await safeAnswer(ctx, 'Starting download...');
  await safeDelete(ctx);

  const { info, verbose, chatId, messageId, postDownload } = pending;
  const log = new NoLog(ctx);
  try {
    if (!postDownload) {
      console.debug(await downloadVideo(ctx, log, info, verbose));
    }
    await sendVideo(ctx, log, info, chatId, messageId);
  } catch (e: any) {
    console.error('Download failed after confirmation:', e);
    try {
      await ctx.telegram.sendMessage(
        chatId,
        `💥 <b>Download failed</b>: ${Bun.escapeHTML(e.message)}`,
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
    url = url.toLowerCase().startsWith('http') ? url : `https://${url}`;

    const log = new NoLog(ctx);
    const info = await getInfo(log, url, false);
    url = info.webpage_url || url;
    console.debug(await downloadVideo(ctx, log, info, false));
    const msg = await sendVideo(ctx, log, info, -4640446184); // TODO: make the cache chat id configurable
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
    } catch {
      // answerInlineQuery can fail if too much time has passed
    }
  }
};
