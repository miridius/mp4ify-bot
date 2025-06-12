import { downloadVideo, getInfo, sendInfo, sendVideo } from './download-video';
import { LogMessage, NoLog } from './log-message';
import type { InlineQueryContext, MessageContext } from './types';

// message needs cache of url -> info & id
// inline needs cache of url -> caption & id

// 1. get info [url -> info cache]
// 2. (private chat only) print video details
// 3. choose format, generate file name
// 4. download+merge [cache by keeping files on disk?]
// 5. upload [file id cache]
// 6. (inline chat only) respond to query
// 7. can we zero out the video files / replace with cache of id?

export const textMessageHandler = async (ctx: MessageContext) => {
  const { text, chat, entities, message_id } = ctx.message || ctx.editedMessage;
  console.debug('got message:', text);
  const verbose = chat.type === 'private' && text.startsWith('/verbose ');

  // Handle all URLs in the message. Intentionally don't await
  await Promise.all(
    entities
      ?.filter((e) => e.type === 'url')
      .map((e) => text.slice(e.offset, e.offset + e.length))
      .map(async (url) => {
        url = url.toLowerCase().startsWith('http') ? url : `https://${url}`;
        const log = new LogMessage(ctx);
        try {
          const info = await getInfo(log, url, verbose);
          info.webpage_url ||= url; // just in case webpage_url is missing
          await sendInfo(log, info, verbose);
          console.debug(await downloadVideo(ctx, log, info, verbose));
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
  }
};
