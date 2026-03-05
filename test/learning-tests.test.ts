/**
 * Learning / contract tests: verify our understanding of external services
 * and ensure our mocks produce structurally compatible data.
 *
 * Each describe block defines shared assertions that run against:
 * 1. Real captured payloads (from fixtures, always run)
 * 2. Mock-generated data (always run, verifies mock parity)
 * 3. Live external services (only when INTEGRATION=1, re-verifies assumptions)
 *
 * If a test passes against fixtures but fails against live services,
 * the external API has changed and we need to update fixtures + mocks.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import payloads from './fixtures/real-payloads.json';
import durationFixtures from './fixtures/video-info-duration.json';
import { MockBotApi } from './simulate-bot-api';

const real = payloads.payloads;
const INTEGRATION = process.env.INTEGRATION === '1';

// ─── Shared assertion helpers ───────────────────────────────────────────────

/** Asserts a Telegram DM text message update has the expected shape */
const assertDmTextMessage = (update: any) => {
  expect(update).toHaveProperty('update_id');
  expect(update).toHaveProperty('message');
  expect(update).not.toHaveProperty('edited_message');

  const { message } = update;
  expect(message).toHaveProperty('message_id');
  expect(message).toHaveProperty('from');
  expect(message).toHaveProperty('chat');
  expect(message).toHaveProperty('date');
  expect(message).toHaveProperty('text');

  // from shape
  expect(message.from.is_bot).toBe(false);
  expect(message.from).toHaveProperty('id');
  expect(message.from).toHaveProperty('first_name');

  // chat shape (private)
  expect(message.chat.type).toBe('private');
  expect(message.chat.id).toBe(message.from.id);
};

/** Asserts a Telegram edited message update has the expected shape */
const assertEditedMessage = (update: any) => {
  expect(update).toHaveProperty('edited_message');
  expect(update).not.toHaveProperty('message');
  expect(update.edited_message).toHaveProperty('edit_date');
  expect(update.edited_message.edit_date).toBeGreaterThanOrEqual(
    update.edited_message.date,
  );
};

/** Asserts a callback_query update has the expected shape */
const assertCallbackQuery = (update: any) => {
  expect(update).toHaveProperty('callback_query');
  expect(update).not.toHaveProperty('message');

  const { callback_query } = update;
  expect(callback_query).toHaveProperty('id');
  expect(callback_query).toHaveProperty('from');
  expect(callback_query).toHaveProperty('message');
  expect(callback_query).toHaveProperty('chat_instance');
  expect(callback_query).toHaveProperty('data');
  expect(callback_query.id).toMatch(/^\d+$/);
  expect(callback_query.from.is_bot).toBe(false);
  expect(callback_query.message.from.is_bot).toBe(true);
};

/** Asserts yt-dlp video info has duration as a positive number */
const assertDurationInfo = (info: any) => {
  expect(info).toHaveProperty('duration');
  expect(info.duration).not.toBeNull();
  expect(info.duration).not.toBeUndefined();
  expect(info.duration).toBeNumber();
  expect(info.duration).toBeGreaterThan(0);
  expect(info.duration_string).toBeString();
};

// ─── Contract tests: real payloads (from fixtures) ──────────────────────────

describe('real payload structure (fixtures)', () => {
  describe('DM plain text', () => {
    it('has expected message shape', () => {
      assertDmTextMessage(real.dm_plain_text);
    });

    it('from has language_code', () => {
      expect(real.dm_plain_text.message.from.language_code).toBe('en');
    });

    it('entities include rich formatting types', () => {
      const types = real.dm_plain_text.message.entities.map(
        (e: any) => e.type,
      );
      expect(types).toContain('bold');
      expect(types).toContain('italic');
      expect(types).toContain('url');
    });
  });

  describe('DM with URL', () => {
    it('url entity extracts correct substring', () => {
      const { message } = real.dm_with_url;
      const urlEntity = message.entities.find((e: any) => e.type === 'url');
      const extracted = message.text.slice(
        urlEntity!.offset,
        urlEntity!.offset + urlEntity!.length,
      );
      expect(extracted).toMatch(/^https?:\/\//);
    });

    it('text_link entity has a url field', () => {
      const textLink = real.dm_with_url.message.entities.find(
        (e: any) => e.type === 'text_link',
      );
      expect(textLink).toBeDefined();
      expect(textLink!.url).toMatch(/^https?:\/\//);
    });
  });

  describe('DM edited message', () => {
    it('has expected edited_message shape', () => {
      assertEditedMessage(real.dm_edited_message);
    });

    it('keeps same message_id as original', () => {
      expect(real.dm_edited_message.edited_message.message_id).toBe(
        real.dm_with_url.message.message_id,
      );
    });
  });

  describe('bot added to group', () => {
    it('uses my_chat_member with group chat', () => {
      const update = real.bot_added_to_group;
      expect(update).toHaveProperty('my_chat_member');
      expect(update.my_chat_member.chat.id).toBeLessThan(0);
      expect(update.my_chat_member.chat.type).toBe('group');
    });

    it('shows status transition from left to member', () => {
      expect(real.bot_added_to_group.my_chat_member.old_chat_member.status).toBe('left');
      expect(real.bot_added_to_group.my_chat_member.new_chat_member.status).toBe('member');
    });
  });

  describe('group message with URL', () => {
    it('chat has negative id, type group, and title', () => {
      const { message } = real.group_message_with_url;
      expect(message.chat.id).toBeLessThan(0);
      expect(message.chat.type).toBe('group');
      expect(message.chat).toHaveProperty('title');
    });

    it('from.id is the user (positive)', () => {
      expect(real.group_message_with_url.message.from.id).toBeGreaterThan(0);
    });
  });

  describe('inline query from group', () => {
    it('has expected inline_query shape', () => {
      const { inline_query } = real.inline_query_group;
      expect(real.inline_query_group).toHaveProperty('inline_query');
      expect(real.inline_query_group).not.toHaveProperty('message');
      expect(inline_query).toHaveProperty('id');
      expect(inline_query).toHaveProperty('from');
      expect(inline_query.chat_type).toBe('group');
      expect(inline_query.query).toContain('https://www.example.com');
      expect(inline_query.offset).toBe('');
      expect(inline_query.id).toMatch(/^\d+$/);
    });
  });

  describe('inline query from DM', () => {
    it('chat_type is sender (not private)', () => {
      expect(real.inline_query_dm.inline_query.chat_type).toBe('sender');
    });
  });

  describe('callback query (button click)', () => {
    it('has expected callback_query shape', () => {
      assertCallbackQuery(real.callback_query_confirm);
    });

    it('data matches the callback_data of the clicked button', () => {
      expect(real.callback_query_confirm.callback_query.data).toBe(
        'test_confirm',
      );
    });

    it('message contains the inline keyboard', () => {
      const kb =
        real.callback_query_confirm.callback_query.message.reply_markup
          .inline_keyboard;
      expect(kb).toBeArray();
      expect(kb[0]).toBeArray();
      expect(kb[0][0]).toHaveProperty('text');
      expect(kb[0][0]).toHaveProperty('callback_data');
    });
  });
});

// ─── Contract tests: MockBotApi parity ──────────────────────────────────────

describe('MockBotApi produces compatible update structures', () => {
  let api: MockBotApi;

  beforeEach(() => {
    api = new MockBotApi();
  });

  it('sendTextMessageToBot matches real DM shape', () => {
    api.sendTextMessageToBot({ text: 'test' } as any);
    const update = api['updates'][0];
    assertDmTextMessage(update);
  });

  it('sendTextMessageToBot with group chat override', () => {
    const groupChat = { id: -5135380628, title: 'Test Group', type: 'group' };
    api.sendTextMessageToBot({ text: 'test' } as any, groupChat);
    const msg = (api['updates'][0] as any).message;
    expect(msg.chat.id).toBeLessThan(0);
    expect(msg.chat.type).toBe('group');
    expect(msg.chat.title).toBe('Test Group');
  });

  it('sendEditedMessageToBot matches real edited_message shape', () => {
    api.sendEditedMessageToBot({ message_id: 42, text: 'edited' } as any);
    const update = api['updates'][0];
    assertEditedMessage(update);
    expect((update as any).edited_message.message_id).toBe(42);
  });

  it('sendCallbackQueryToBot matches real callback_query shape', () => {
    api.sendTextMessageToBot({ text: 'test' } as any);
    api.sendCallbackQueryToBot(0, 'test_data');
    const update = api['updates'][1];
    assertCallbackQuery(update);
    expect((update as any).callback_query.data).toBe('test_data');
  });

  it('getMe response matches real bot shape', async () => {
    const { apiRoot } = await import('../src/consts');
    const url = new URL(`${apiRoot}/bot${api.botToken}/getMe`);
    const resp = api.handle(url, { method: 'POST', body: '{}' }) as Response;
    const json = await resp.json();
    const result = json.result;
    expect(result.is_bot).toBe(true);
    expect(result).toHaveProperty('can_join_groups');
    expect(result).toHaveProperty('can_read_all_group_messages');
    expect(result).toHaveProperty('supports_inline_queries');
    expect(result).toHaveProperty('can_connect_to_business');
    expect(result).toHaveProperty('has_main_web_app');
  });
});

// ─── Contract tests: yt-dlp duration (fixtures) ────────────────────────────

describe('yt-dlp duration reporting (fixtures)', () => {
  const populated = Object.entries(durationFixtures.services).filter(
    ([, v]) => (v as any).duration != null,
  );

  it.each(populated)('%s has valid duration info', (_key, entry) => {
    assertDurationInfo(entry);
  });
});

// ─── Integration tests: live yt-dlp calls ───────────────────────────────────

const describeIntegration = INTEGRATION ? describe : describe.skip;

describeIntegration('yt-dlp duration reporting (live)', () => {
  const entries = Object.entries(durationFixtures.services)
    .filter(([, v]) => (v as any).url)
    .map(([k, v]) => [k, v as any] as const);

  it.each(entries)(
    '%s matches fixture from real yt-dlp',
    async (service, fixture) => {
      const proc = Bun.spawn(
        ['yt-dlp', fixture.url, '--no-warnings', '--dump-json', '--no-check-certificates'],
        { stderr: 'pipe', timeout: 60000 },
      );
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      if (!stdout.trim()) {
        throw new Error(`yt-dlp returned no output for ${service}: ${stderr.trim()}`);
      }
      const info = JSON.parse(stdout);
      assertDurationInfo(info);

      // Verify fixture matches reality
      const fields = ['extractor', 'duration', 'duration_string', 'is_live', 'was_live'] as const;
      for (const field of fields) {
        const actual = info[field] ?? null;
        const expected = fixture[field] ?? null;
        if (actual !== expected) {
          throw new Error(
            `Fixture mismatch for ${service}.${field}: fixture=${JSON.stringify(expected)}, actual=${JSON.stringify(actual)}`,
          );
        }
      }
      console.log(`  ${service}: duration=${info.duration} (${info.duration_string})`);
    },
    120000,
  );
});
