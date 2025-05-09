import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { downloadAndSendVideo } from './download-video';

const bot = new Telegraf(
  Bun.env.BOT_TOKEN ||
    (() => {
      throw new Error('BOT_TOKEN env var is required');
    })(),
);

bot.on(message('text'), async (ctx) => {
  const { text, entities } = ctx.message;
  const verbose =
    ctx.message.chat.type === 'private' && text.startsWith('/verbose ');
  // Handle all URLs in the message
  await Promise.all(
    entities
      ?.filter((e) => e.type === 'url')
      .map((e) => text.slice(e.offset, e.offset + e.length))
      .map(async (url) => {
        url = url.toLowerCase().startsWith('http') ? url : `https://${url}`;
        await downloadAndSendVideo(ctx, url, verbose);
      }) || [],
  );
});

bot.launch();

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
