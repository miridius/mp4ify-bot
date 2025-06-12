import type { Context } from 'telegraf';
import type { Message, Update } from 'telegraf/types';

export type MessageContext = Context<Update.MessageUpdate<Message.TextMessage>>;
export type InlineQueryContext = Context<Update.InlineQueryUpdate>;

export type AnyContext = MessageContext | InlineQueryContext;
