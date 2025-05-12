import { type Context, type NarrowedContext } from 'telegraf';
import type { Message, Update } from 'telegraf/types';

const MAX_LENGTH = 4096;
const TEXT_MSG_OPTS = {
  parse_mode: 'HTML' as const,
  link_preview_options: { is_disabled: true },
  disable_notification: true,
};
const DEBOUNCE_MS = 150;

export type MessageContext = NarrowedContext<
  Context<Update>,
  Update.MessageUpdate<Record<'text', {}> & Message.TextMessage>
>;

export const reply = (ctx: MessageContext, text: string) =>
  ctx.reply(text, {
    reply_parameters: { message_id: ctx.message.message_id },
    ...TEXT_MSG_OPTS,
  });

// Writes log output to a private chat by updating a single message.
export class LogMessage {
  private texts: string[] = [];
  private messages: Message.TextMessage[] = [];
  private ctx?: MessageContext;
  private timer?: Timer;

  constructor(ctx: Context, initialText?: string) {
    if (ctx.message && ctx.chat?.type === 'private') {
      this.ctx = ctx as MessageContext;
    }
    if (initialText) this.append(initialText);
  }

  append(line: string) {
    console.log(line);
    if (!this.ctx) return;
    if (this.timer) clearTimeout(this.timer);
    if (this.texts.length === 0) {
      this.texts.push(line);
    } else {
      let newText = this.texts[this.texts.length - 1] + '\n' + line;
      if (newText.length > MAX_LENGTH) {
        this.texts.push(`<i>...continued...</i>\n\n${line}`);
      } else {
        this.texts[this.texts.length - 1] = newText;
      }
    }
    this.timer = setTimeout(() => this.flush(), DEBOUNCE_MS);
  }

  async flush() {
    if (!this.ctx) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.messages = await Promise.all(
      this.texts.map((text, i) => this.setMessageText(text, this.messages[i])),
    );
  }

  private async setMessageText(text: string, message?: Message.TextMessage) {
    if (!message) {
      return await reply(this.ctx!, text);
    } else if (message.text !== text) {
      try {
        return (await this.ctx!.telegram.editMessageText(
          message.chat.id,
          message.message_id,
          undefined,
          text,
          TEXT_MSG_OPTS,
        )) as Message.TextMessage;
      } catch (e) {
        console.error('Failed to edit message', text, e);
      }
    }
    return message;
  }
}

export class NoLog extends LogMessage {
  append(_line: string) {}
  async flush() {}
}
