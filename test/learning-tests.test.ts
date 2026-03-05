/**
 * Learning tests: validate our understanding of real Telegram API payloads
 * and ensure MockBotApi produces structurally compatible updates.
 *
 * These tests use real payloads captured from getUpdates on 2026-03-05.
 * If Telegram changes their API, these tests document the expected shapes.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import payloads from './fixtures/real-payloads.json';
import { MockBotApi } from './simulate-bot-api';

const real = payloads.payloads;

describe('real payload structure', () => {
  describe('DM plain text', () => {
    const { message } = real.dm_plain_text;

    it('has expected top-level keys', () => {
      expect(real.dm_plain_text).toHaveProperty('update_id');
      expect(real.dm_plain_text).toHaveProperty('message');
      expect(real.dm_plain_text).not.toHaveProperty('edited_message');
    });

    it('message has from, chat, date, text, entities', () => {
      expect(message).toHaveProperty('message_id');
      expect(message).toHaveProperty('from');
      expect(message).toHaveProperty('chat');
      expect(message).toHaveProperty('date');
      expect(message).toHaveProperty('text');
      expect(message).toHaveProperty('entities');
    });

    it('from has expected user fields', () => {
      expect(message.from).toMatchObject({
        is_bot: false,
        language_code: 'en',
      });
      expect(message.from).toHaveProperty('id');
      expect(message.from).toHaveProperty('first_name');
      expect(message.from).toHaveProperty('username');
    });

    it('chat type is private and matches from.id', () => {
      expect(message.chat.type).toBe('private');
      expect(message.chat.id).toBe(message.from.id);
    });

    it('entities include rich formatting types', () => {
      const types = message.entities.map((e: any) => e.type);
      expect(types).toContain('bold');
      expect(types).toContain('italic');
      expect(types).toContain('blockquote');
      expect(types).toContain('pre');
      expect(types).toContain('code');
      expect(types).toContain('url');
    });

    it('pre entity has language field', () => {
      const pre = message.entities.find((e: any) => e.type === 'pre');
      expect(pre).toHaveProperty('language');
    });
  });

  describe('DM with URL', () => {
    const { message } = real.dm_with_url;

    it('url entity has offset and length', () => {
      const urlEntity = message.entities.find((e: any) => e.type === 'url');
      expect(urlEntity).toHaveProperty('offset');
      expect(urlEntity).toHaveProperty('length');
      // verify it extracts the right substring
      const extracted = message.text.slice(
        urlEntity!.offset,
        urlEntity!.offset + urlEntity!.length,
      );
      expect(extracted).toMatch(/^https?:\/\//);
    });

    it('text_link entity has a url field', () => {
      const textLink = message.entities.find(
        (e: any) => e.type === 'text_link',
      );
      expect(textLink).toBeDefined();
      expect(textLink).toHaveProperty('url');
      expect(textLink!.url).toMatch(/^https?:\/\//);
    });

    it('has link_preview_options', () => {
      expect(message).toHaveProperty('link_preview_options');
    });
  });

  describe('DM edited message', () => {
    const update = real.dm_edited_message;

    it('uses edited_message key, not message', () => {
      expect(update).toHaveProperty('edited_message');
      expect(update).not.toHaveProperty('message');
    });

    it('edited_message has edit_date', () => {
      expect(update.edited_message).toHaveProperty('edit_date');
      expect(update.edited_message.edit_date).toBeGreaterThan(
        update.edited_message.date,
      );
    });

    it('keeps same message_id as original', () => {
      expect(update.edited_message.message_id).toBe(
        real.dm_with_url.message.message_id,
      );
    });
  });

  describe('bot added to group', () => {
    const update = real.bot_added_to_group;

    it('uses my_chat_member key', () => {
      expect(update).toHaveProperty('my_chat_member');
      expect(update).not.toHaveProperty('message');
    });

    it('group chat has negative id', () => {
      expect(update.my_chat_member.chat.id).toBeLessThan(0);
    });

    it('chat type is group', () => {
      expect(update.my_chat_member.chat.type).toBe('group');
    });

    it('shows status transition from left to member', () => {
      expect(update.my_chat_member.old_chat_member.status).toBe('left');
      expect(update.my_chat_member.new_chat_member.status).toBe('member');
    });
  });

  describe('group message with URL', () => {
    const { message } = real.group_message_with_url;

    it('chat has negative id and type group', () => {
      expect(message.chat.id).toBeLessThan(0);
      expect(message.chat.type).toBe('group');
    });

    it('chat has title', () => {
      expect(message.chat).toHaveProperty('title');
    });

    it('from.id is still the user (positive)', () => {
      expect(message.from.id).toBeGreaterThan(0);
    });

    it('has url entity', () => {
      const urlEntity = message.entities.find((e: any) => e.type === 'url');
      expect(urlEntity).toBeDefined();
    });
  });
  describe('inline query from group', () => {
    const { inline_query } = real.inline_query_group;

    it('uses inline_query key, not message', () => {
      expect(real.inline_query_group).toHaveProperty('inline_query');
      expect(real.inline_query_group).not.toHaveProperty('message');
    });

    it('has id, from, chat_type, query, offset', () => {
      expect(inline_query).toHaveProperty('id');
      expect(inline_query).toHaveProperty('from');
      expect(inline_query).toHaveProperty('chat_type');
      expect(inline_query).toHaveProperty('query');
      expect(inline_query).toHaveProperty('offset');
    });

    it('chat_type is group', () => {
      expect(inline_query.chat_type).toBe('group');
    });

    it('query contains the accumulated typed text', () => {
      expect(inline_query.query).toContain('https://www.example.com');
    });

    it('offset is empty string', () => {
      expect(inline_query.offset).toBe('');
    });

    it('id is a numeric string', () => {
      expect(inline_query.id).toMatch(/^\d+$/);
    });
  });

  describe('inline query from DM', () => {
    const { inline_query } = real.inline_query_dm;

    it('chat_type is sender (not private)', () => {
      expect(inline_query.chat_type).toBe('sender');
    });
  });
});

describe('MockBotApi produces compatible update structures', () => {
  let api: MockBotApi;

  beforeEach(() => {
    api = new MockBotApi();
  });

  it('sendTextMessageToBot produces update with message key', () => {
    api.sendTextMessageToBot({
      text: 'hello',
      entities: [{ type: 'url', offset: 0, length: 5 }],
    } as any);
    const update = api['updates'][0];
    expect(update).toHaveProperty('update_id');
    expect(update).toHaveProperty('message');
    expect(update).not.toHaveProperty('edited_message');
  });

  it('sendTextMessageToBot message has same shape as real DM', () => {
    api.sendTextMessageToBot({ text: 'test' } as any);
    const msg = (api['updates'][0] as any).message;
    // Same fields as real payload
    expect(msg).toHaveProperty('message_id');
    expect(msg).toHaveProperty('from');
    expect(msg).toHaveProperty('chat');
    expect(msg).toHaveProperty('date');
    expect(msg).toHaveProperty('text');
    // from shape
    expect(msg.from.is_bot).toBe(false);
    expect(msg.from.language_code).toBe('en');
    expect(msg.from).toHaveProperty('id');
    expect(msg.from).toHaveProperty('first_name');
    // chat shape (private)
    expect(msg.chat.type).toBe('private');
    expect(msg.chat.id).toBe(msg.from.id);
  });

  it('sendTextMessageToBot with group chat override', () => {
    const groupChat = { id: -5135380628, title: 'Test Group', type: 'group' };
    api.sendTextMessageToBot({ text: 'test' } as any, groupChat);
    const msg = (api['updates'][0] as any).message;
    expect(msg.chat.id).toBeLessThan(0);
    expect(msg.chat.type).toBe('group');
    expect(msg.chat.title).toBe('Test Group');
  });

  it('sendEditedMessageToBot produces update with edited_message key and edit_date', () => {
    api.sendEditedMessageToBot({
      message_id: 42,
      text: 'edited',
    } as any);
    const update = api['updates'][0] as any;
    expect(update).toHaveProperty('edited_message');
    expect(update).not.toHaveProperty('message');
    expect(update.edited_message).toHaveProperty('edit_date');
    expect(update.edited_message.edit_date).toBeGreaterThanOrEqual(
      update.edited_message.date,
    );
    expect(update.edited_message.message_id).toBe(42);
  });

  it('getMe response matches real bot shape', async () => {
    const { apiRoot } = await import('../src/consts');
    const url = new URL(`${apiRoot}/bot${api.botToken}/getMe`);
    const resp = api.handle(url, { method: 'POST', body: '{}' }) as Response;
    const json = await resp.json();
    const result = json.result;
    // Compare with real getMe fields
    expect(result.is_bot).toBe(true);
    expect(result).toHaveProperty('can_join_groups');
    expect(result).toHaveProperty('can_read_all_group_messages');
    expect(result).toHaveProperty('supports_inline_queries');
    expect(result).toHaveProperty('can_connect_to_business');
    expect(result).toHaveProperty('has_main_web_app');
  });
});
