import he from 'he';
import { type Context, type NarrowedContext } from 'telegraf';
import type { Message, Update } from 'telegraf/types';

const MAX_LENGTH = 4096;
const TRUNCATED_MSG = '\n<i>--- message too long ---</i>';
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

export const reply = (
  ctx: NarrowedContext<Context<Update>, Update.MessageUpdate>,
  text: string,
) =>
  ctx.reply(text, {
    reply_parameters: { message_id: ctx.message.message_id },
    ...TEXT_MSG_OPTS,
  });

// Writes log output to a private chat by updating a single message.
export class LogMessage {
  private text = '';
  private enabled: boolean;
  private timer?: Timer;
  private message?: Message.TextMessage;

  constructor(private ctx: MessageContext, initialText?: string) {
    this.enabled = this.ctx.chat?.type === 'private';
    if (initialText) this.append(initialText);
  }

  append(text: string, sanitize = false) {
    if (!this.enabled) return;
    console.log(text);
    this.text += (sanitize ? he.encode(text) : text) + '\n';
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), DEBOUNCE_MS);
  }

  async flush() {
    if (!this.enabled) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.setMessageText();
  }

  private async setMessageText() {
    let text = this.text.trim();
    if (text.length > MAX_LENGTH) {
      text = text.slice(0, MAX_LENGTH - TRUNCATED_MSG.length) + TRUNCATED_MSG;
      this.enabled = false; // prevent further updates as they are pointless
    }
    if (!this.message) {
      this.message = await reply(this.ctx, text);
    } else if (this.message.text !== text) {
      try {
        await this.ctx.telegram.editMessageText(
          this.message.chat.id,
          this.message.message_id,
          undefined,
          text,
          TEXT_MSG_OPTS,
        );
        this.message.text = text;
      } catch (e) {
        console.error('Failed to edit message', text, e);
      }
    }
  }
}
