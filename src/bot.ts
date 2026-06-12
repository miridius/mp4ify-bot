import { Telegraf } from 'telegraf';
import { allOf, editedMessage, message, type Filter } from 'telegraf/filters';
import type { Update } from 'telegraf/types';
import { apiRoot } from './consts';
import { updateYtdlp, YTDLP_UPDATE_INTERVAL_MS } from './download-video';
import {
  callbackQueryHandler,
  inlineQueryHandler,
  processJob,
  textMessageHandler,
} from './handlers';
import { startJobQueue, stopJobQueue } from './job-queue';

export const start = async (botToken: string) => {
  // keep yt-dlp fresh: extractors break as sites change out from under us
  updateYtdlp();
  setInterval(updateYtdlp, YTDLP_UPDATE_INTERVAL_MS).unref();

  const bot = new Telegraf(botToken, {
    telegram: { apiRoot },
    // downloads run via the job queue, so handlers are quick; this only
    // bounds stragglers (e.g. inline queries, which download in-handler)
    handlerTimeout: 5 * 60 * 1000,
  });
  console.debug(bot.telegram.options);

  bot.catch((err, ctx) => {
    // only inline queries legitimately run long (they download in-handler);
    // a timeout on the enqueue-only handlers means something is hung
    if (
      err instanceof Error &&
      err.name === 'TimeoutError' &&
      'inline_query' in ctx.update
    ) {
      // p-timeout rejection: the handler keeps running detached and its
      // work still completes; polling has already moved on
      console.warn('Slow handler unblocked (still running):', ctx.update);
      return;
    }
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

  // start workers only now: recovered jobs need botInfo for file naming
  await startJobQueue((job) => processJob(bot.telegram, bot.botInfo!.username, job));

  // queued-but-unstarted jobs stay on disk for the next boot instead of
  // racing docker's kill grace period
  process.once('SIGINT', () => {
    stopJobQueue();
    bot.stop('SIGINT');
  });
  process.once('SIGTERM', () => {
    stopJobQueue();
    bot.stop('SIGTERM');
  });

  return bot;
};
