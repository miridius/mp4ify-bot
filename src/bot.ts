import { Telegraf } from 'telegraf';
import { allOf, editedMessage, message, type Filter } from 'telegraf/filters';
import type { Update } from 'telegraf/types';
import { apiRoot } from './consts';
import { inlineQueryHandler, textMessageHandler } from './handlers';

export const start = async (botToken: string) => {
  const bot = new Telegraf(botToken, { telegram: { apiRoot } });
  console.debug(bot.telegram.options);

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

  bot.use((ctx) => console.log('unhandled update:', ctx.update));

  bot.launch();
  // wait for the bot to start
  while (!(bot as any).polling) await Bun.sleep(100);

  // Enable graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));

  return bot;
};
