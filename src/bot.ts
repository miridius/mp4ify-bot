import { Telegraf } from 'telegraf';
import { allOf, editedMessage, message, type Filter } from 'telegraf/filters';
import type { Update } from 'telegraf/types';
import { apiRoot } from './consts';
import {
  DOWNLOAD_TIMEOUT_SECS,
  updateYtdlp,
  YTDLP_UPDATE_INTERVAL_MS,
} from './download-video';
import {
  callbackQueryHandler,
  inlineQueryHandler,
  textMessageHandler,
} from './handlers';

export const start = async (botToken: string) => {
  // keep yt-dlp fresh: extractors break as sites change out from under us
  updateYtdlp();
  setInterval(updateYtdlp, YTDLP_UPDATE_INTERVAL_MS).unref();

  const bot = new Telegraf(botToken, {
    telegram: { apiRoot },
    // scrape + download (two yt-dlp runs) plus a multi-GB upload must fit:
    // telegraf rejects handleUpdate at this timeout (default: 90s)
    handlerTimeout: (2 * DOWNLOAD_TIMEOUT_SECS + 20 * 60) * 1000,
  });
  console.debug(bot.telegram.options);

  bot.catch((err, ctx) => {
    console.error('Unhandled error while processing', ctx.update, err);
    process.exitCode = 1; // keep telegraf's exit-code-on-error behavior
  });

  bot.on(message('text'), (ctx) => textMessageHandler(ctx));
  bot.on(
    allOf(
      editedMessage('text'),
      // edited message updates in group chats are sent on emoji reactions,
      // so we have to ignore them to avoid spamming groups. In future we should
      // keep a db of urls we've seen in messages so that we can distinguish
      // meaningful edits
      ((u: Update.EditedMessageUpdate) =>
        u.edited_message.chat.type ===
        'private') as Filter<Update.EditedMessageUpdate>,
    ),
    (ctx) => textMessageHandler(ctx),
  );
  bot.on('inline_query', (ctx) => inlineQueryHandler(ctx));
  bot.on('callback_query', (ctx) => callbackQueryHandler(ctx));

  bot.use((ctx) => console.log('unhandled update:', ctx.update));

  // launch() only settles when polling stops, so don't await it; a
  // rejection means polling died fatally — exit so docker restarts us
  await new Promise<void>((onLaunch) => {
    bot.launch(onLaunch).catch((e) => {
      console.error('Bot crashed:', e);
      process.exit(1);
    });
  });
  // onLaunch fires before telegraf assigns its polling field, and stop()
  // throws until it does - wait (bounded, in case telegraf renames it)
  const deadline = Date.now() + 30_000;
  while (!(bot as any).polling && Date.now() < deadline) await Bun.sleep(5);

  // Enable graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));

  return bot;
};
