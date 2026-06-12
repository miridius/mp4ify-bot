import type { Telegram } from 'telegraf';
import type { Message } from 'telegraf/types';

const MAX_LENGTH = 4096;
const TEXT_MSG_OPTS = {
  parse_mode: 'HTML' as const,
  link_preview_options: { is_disabled: true },
  disable_notification: true,
};
const DEBOUNCE_MS = 150;

export type LogDest = {
  chatId: number;
  chatType: string;
  replyTo: number;
};

// Writes log output to a private chat by updating a single message.
export class LogMessage {
  private texts: string[] = [];
  private messages: (Message.TextMessage | undefined)[] = [];
  private dest?: LogDest;
  private timer?: Timer;

  constructor(
    private telegram?: Telegram,
    dest?: LogDest,
    initialText?: string,
  ) {
    if (telegram && dest?.chatType === 'private') this.dest = dest;
    if (initialText) this.append(initialText);
  }

  append(line: string) {
    console.debug(line);
    if (!this.dest) return;
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
    this.timer = setTimeout(
      () => this.flush().catch((e) => console.error('Log flush failed:', e)),
      DEBOUNCE_MS,
    );
  }

  async flush() {
    if (!this.dest) return;
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
      try {
        return (await this.telegram!.sendMessage(this.dest!.chatId, text, {
          reply_parameters: { message_id: this.dest!.replyTo },
          ...TEXT_MSG_OPTS,
        })) as Message.TextMessage;
      } catch (e) {
        console.error('Failed to send log message', text, e);
        return undefined; // retried on the next flush
      }
    } else if (message.text !== text.replaceAll(/<[^>]+>/g, '')) {
      try {
        return (await this.telegram!.editMessageText(
          message.chat.id,
          message.message_id,
          undefined,
          text,
          TEXT_MSG_OPTS,
        )) as Message.TextMessage;
      } catch (e) {
        console.error('Failed to edit message', text, e);
        // Mark text as "sent" to prevent cascading retries with the same content
        message.text = text.replaceAll(/<[^>]+>/g, '');
      }
    }
    return message;
  }
}

export class NoLog extends LogMessage {
  constructor() {
    super();
  }
  append(_line: string) {}
  async flush() {}
}
