import { Telegraf } from 'telegraf';
import { editedMessage, message } from 'telegraf/filters';
import { apiRoot } from './consts';
import { inlineQueryHandler, textMessageHandler } from './handlers';

export const start = async (botToken: string) => {
  const bot = new Telegraf(botToken, { telegram: { apiRoot } });
  console.debug(bot.telegram.options);

  bot.on(message('text'), (ctx) => textMessageHandler(ctx));
  bot.on(editedMessage('text'), (ctx) => textMessageHandler(ctx));
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
