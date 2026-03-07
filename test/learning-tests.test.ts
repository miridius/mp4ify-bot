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
import classifyFixtures from './fixtures/classify-url.json';
import anthropicFixtures from './fixtures/anthropic-responses.json';
import durationFixtures from './fixtures/video-info-duration.json';
import articleFixtures from './fixtures/ytdlp-article.json';
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

// ─── Contract tests: yt-dlp on news article URLs (fixtures) ─────────────────

describe('yt-dlp on news article URLs (fixtures)', () => {
  const articles = Object.entries(articleFixtures.articles);

  // Only run if fixtures have been captured
  (articles.length > 0 ? describe : describe.skip)('captured articles', () => {
    it.each(articles)('%s has extractor field', (_key, entry: any) => {
      if (entry.error) {
        // If yt-dlp errored, that's also valid data (means no video found)
        expect(entry.error).toBeString();
        return;
      }
      expect(entry).toHaveProperty('extractor');
      expect(entry.extractor).toBeString();
    });

    it.each(articles.filter(([, e]: any) => !e.error))(
      '%s uses generic extractor for article page',
      (_key, entry: any) => {
        // Key assumption: yt-dlp uses "generic" extractor for news articles
        expect(entry.extractor.toLowerCase()).toStartWith('generic');
      },
    );
  });
});

// ─── Helper: save fixture file ──────────────────────────────────────────────

const saveFixture = async (path: string, data: any) => {
  await Bun.write(path, JSON.stringify(data, null, 2) + '\n');
};

// ─── Integration tests: live yt-dlp calls ───────────────────────────────────

const describeIntegration = INTEGRATION ? describe : describe.skip;

// ─── Shared assertion: Anthropic messages.create response ───────────────────

/** Asserts the raw Anthropic messages.create response has the expected shape */
const assertAnthropicResponse = (msg: any) => {
  expect(msg).toHaveProperty('id');
  expect(msg.id).toBeString();
  expect(msg.id).toStartWith('msg_');

  expect(msg).toHaveProperty('type', 'message');
  expect(msg).toHaveProperty('role', 'assistant');

  expect(msg).toHaveProperty('model');
  expect(msg.model).toBeString();

  expect(msg).toHaveProperty('content');
  expect(msg.content).toBeArray();
  expect(msg.content.length).toBeGreaterThan(0);
  expect(msg.content[0]).toHaveProperty('type', 'text');
  expect(msg.content[0]).toHaveProperty('text');
  expect(msg.content[0].text).toBeString();

  expect(msg).toHaveProperty('stop_reason');
  expect(msg.stop_reason).toBeString();

  expect(msg).toHaveProperty('usage');
  expect(msg.usage).toHaveProperty('input_tokens');
  expect(msg.usage).toHaveProperty('output_tokens');
  expect(msg.usage.input_tokens).toBeNumber();
  expect(msg.usage.output_tokens).toBeNumber();
};

/** Asserts max_tokens:1 response: stop_reason is max_tokens, text is a single word */
const assertMaxTokens1Response = (msg: any) => {
  assertAnthropicResponse(msg);
  expect(msg.stop_reason).toBe('max_tokens');
  expect(msg.usage.output_tokens).toBe(1);

  // With max_tokens:1, the text should still be a complete, usable word
  const text = msg.content[0].text.trim();
  expect(text.length).toBeGreaterThan(0);
  // Should not contain spaces (single token = single word)
  expect(text).not.toContain(' ');
};

/** Asserts classifyUrl returns a valid classification */
const assertClassification = (result: string, expected: string) => {
  expect(result).toBeOneOf(['article', 'video']);
  expect(result).toBe(expected);
};

/** Creates a fake Anthropic client that returns a canned text response */
const fakeAnthropicClient = (response: string) =>
  ({
    messages: {
      create: async () => ({
        id: 'msg_fake123',
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-4-5-20251001',
        content: [{ type: 'text', text: response }],
        stop_reason: 'max_tokens',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      }),
    },
  }) as any;

// ─── Contract tests: Anthropic response fixtures ────────────────────────────

describe('Anthropic API response structure (fixtures)', () => {
  const fixtureEntries = Object.entries(anthropicFixtures.responses);

  // Only run if fixtures have been captured
  (fixtureEntries.length > 0 ? describe : describe.skip)(
    'captured responses',
    () => {
      it.each(fixtureEntries)(
        '%s has valid response structure',
        (_key, entry: any) => {
          assertMaxTokens1Response(entry.raw);
        },
      );

      it.each(fixtureEntries)(
        '%s response text is "article" or "video"',
        (_key, entry: any) => {
          const text = entry.raw.content[0].text.trim().toLowerCase();
          expect(text).toBeOneOf(['article', 'video']);
          expect(text).toBe(entry.expected);
        },
      );
    },
  );
});

// ─── Contract tests: fakeAnthropicClient parity ─────────────────────────────

describe('fakeAnthropicClient matches real response structure', () => {
  it('produces valid Anthropic response shape', async () => {
    const client = fakeAnthropicClient('article');
    const msg = await client.messages.create({});
    assertAnthropicResponse(msg);
  });

  it('produces valid max_tokens:1 response', async () => {
    const client = fakeAnthropicClient('article');
    const msg = await client.messages.create({});
    assertMaxTokens1Response(msg);
  });
});

// ─── Contract tests: classifyUrl with mock client ───────────────────────────

describe('URL classification (mock client)', () => {
  it.each(classifyFixtures.cases)(
    '$url → $expected',
    async ({ url, title, expected }) => {
      const { classifyUrl } = await import('../src/classify-url');
      const client = fakeAnthropicClient(expected);
      const result = await classifyUrl(url, title, client);
      assertClassification(result, expected);
    },
  );

  it('defaults to video for unrecognized response', async () => {
    const { classifyUrl } = await import('../src/classify-url');
    const client = fakeAnthropicClient('unknown');
    const result = await classifyUrl('https://example.com', undefined, client);
    expect(result).toBe('video');
  });

  it('handles case-insensitive response', async () => {
    const { classifyUrl } = await import('../src/classify-url');
    const client = fakeAnthropicClient('Article');
    const result = await classifyUrl('https://example.com', undefined, client);
    expect(result).toBe('article');
  });
});

// ─── Integration tests: live Anthropic API ──────────────────────────────────

describeIntegration('URL classification (live Anthropic API)', () => {
  if (!process.env.ANTHROPIC_API_KEY) {
    it('ANTHROPIC_API_KEY is required', () => {
      throw new Error(
        'ANTHROPIC_API_KEY is required for integration tests. ' +
          'Add it to .env.dev or pass it to the container.',
      );
    });
    return;
  }

  const captured: Record<string, any> = {};

  it.each(classifyFixtures.cases)(
    'classifyUrl: $url → $expected (captures fixture)',
    async ({ url, title, expected }) => {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const client = new Anthropic();

      // Call raw API to capture the full response
      const prompt = `Is this URL a news article/blog post, or a video/media page? Reply with exactly one word: "article" or "video".\n\nURL: ${url}${title ? `\nPage title: ${title}` : ''}`;
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: prompt }],
      });

      // Assert response structure
      assertMaxTokens1Response(msg);
      const text =
        msg.content[0]?.type === 'text'
          ? msg.content[0].text.trim().toLowerCase()
          : '';
      expect(text).toBeOneOf(['article', 'video']);
      expect(text).toBe(expected);

      // Capture for fixture
      const key = url.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9]/g, '_');
      captured[key] = { url, expected, raw: msg };
      console.log(`  ${url} → "${text}" (expected: "${expected}")`);
    },
    30000,
  );

  it('saves captured Anthropic responses to fixture', async () => {
    if (Object.keys(captured).length === 0) {
      throw new Error('No Anthropic responses were captured');
    }
    await saveFixture('test/fixtures/anthropic-responses.json', {
      description:
        'Raw Anthropic API responses captured by learning tests. Re-run with INTEGRATION=1 to update.',
      responses: captured,
    });
    console.log(
      `  Saved ${Object.keys(captured).length} responses to test/fixtures/anthropic-responses.json`,
    );
  });
});

describeIntegration('yt-dlp on news article URLs (live)', () => {
  const articleUrls = [
    ['bbc_news', 'https://www.bbc.com/news/world-us-canada-61377951'],
    ['arstechnica', 'https://arstechnica.com/science/2024/04/nasas-voyager-1-starts-talking-to-us-again/'],
    ['cnn_with_video', 'https://www.cnn.com/2024/04/08/weather/total-solar-eclipse-monday/index.html'],
  ] as const;

  const capturedArticles: Record<string, any> = {};
  const ytdlpFields = ['extractor', 'extractor_key', 'webpage_url', 'title', 'duration', 'duration_string', 'is_live', 'was_live'] as const;

  it.each(articleUrls)(
    '%s: verify yt-dlp behavior on article URL (captures fixture)',
    async (name, url) => {
      const proc = Bun.spawn(
        ['yt-dlp', url, '--no-warnings', '--dump-json', '--no-check-certificates', '--no-download'],
        { stderr: 'pipe', timeout: 60000 },
      );
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0 || !stdout.trim()) {
        const errorMsg = stderr.trim().split('\n')[0];
        console.log(`  ${name}: yt-dlp error (exit ${exitCode}): ${errorMsg}`);
        capturedArticles[name] = {
          url,
          error: errorMsg,
          exitCode,
          note: 'yt-dlp could not extract video from this article',
        };
        return;
      }

      const info = JSON.parse(stdout);
      console.log(`  ${name}: extractor=${info.extractor}, title=${info.title?.slice(0, 60)}`);

      const captured: Record<string, any> = { url };
      for (const field of ytdlpFields) {
        captured[field] = info[field] ?? null;
      }
      capturedArticles[name] = captured;
    },
    120000,
  );

  it('saves captured article data to fixture', async () => {
    if (Object.keys(capturedArticles).length === 0) {
      throw new Error('No article data was captured');
    }
    await saveFixture('test/fixtures/ytdlp-article.json', {
      description:
        'yt-dlp output for news article URLs. Re-run with INTEGRATION=1 to update.',
      articles: capturedArticles,
    });
    console.log(
      `  Saved ${Object.keys(capturedArticles).length} articles to test/fixtures/ytdlp-article.json`,
    );
  });
});

describeIntegration('yt-dlp duration reporting (live)', () => {
  const durationFields = ['extractor', 'duration', 'duration_string', 'is_live', 'was_live'] as const;
  const entries = Object.entries(durationFixtures.services)
    .filter(([, v]) => (v as any).url)
    .map(([k, v]) => [k, v as any] as const);

  let fixtureChanged = false;

  it.each(entries)(
    '%s: captures duration info from real yt-dlp',
    async (service, fixture) => {
      const proc = Bun.spawn(
        ['yt-dlp', fixture.url, '--no-warnings', '--dump-json', '--no-check-certificates'],
        { stderr: 'pipe', timeout: 60000 },
      );
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      expect(stdout.trim()).not.toBe(
        `${service}: yt-dlp failed: ${stderr.trim().split('\n')[0]}`,
      );
      const info = JSON.parse(stdout);
      assertDurationInfo(info);

      // Update fixture in-place
      for (const field of durationFields) {
        const newVal = info[field] ?? null;
        if (fixture[field] !== newVal) {
          console.log(`  ${service}.${field}: ${JSON.stringify(fixture[field])} → ${JSON.stringify(newVal)}`);
          fixture[field] = newVal;
          fixtureChanged = true;
        }
      }
      console.log(`  ${service}: duration=${info.duration} (${info.duration_string})`);
    },
    120000,
  );

  it('saves updated duration fixtures', async () => {
    if (fixtureChanged) {
      await saveFixture('test/fixtures/video-info-duration.json', durationFixtures);
      console.log('  Updated test/fixtures/video-info-duration.json');
    } else {
      console.log('  Duration fixtures already up to date');
    }
  });
});
