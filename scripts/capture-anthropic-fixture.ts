/**
 * Captures real Anthropic API responses for classify-url learning tests.
 * Saves the raw response objects so we can verify mock parity.
 *
 * Run via: ANTHROPIC_API_KEY=... bun scripts/capture-anthropic-fixture.ts
 */
import Anthropic from '@anthropic-ai/sdk';
import classifyCases from '../test/fixtures/classify-url.json';

const client = new Anthropic();
const fixturePath = 'test/fixtures/anthropic-responses.json';

const responses: Record<string, any> = {};

for (const { url, title, expected } of classifyCases.cases) {
  const prompt = `Is this URL a news article/blog post, or a video/media page? Reply with exactly one word: "article" or "video".\n\nURL: ${url}${title ? `\nPage title: ${title}` : ''}`;

  console.log(`Classifying: ${url}`);
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1,
    messages: [{ role: 'user', content: prompt }],
  });

  const text =
    msg.content[0]?.type === 'text' ? msg.content[0].text.trim().toLowerCase() : '';
  console.log(`  Response: "${text}" (expected: "${expected}", stop_reason: ${msg.stop_reason})`);

  const key = url.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9]/g, '_');
  responses[key] = {
    url,
    expected,
    raw: msg,
  };
}

await Bun.write(fixturePath, JSON.stringify({ description: 'Raw Anthropic API responses captured for learning tests. Re-run scripts/capture-anthropic-fixture.ts to update.', responses }, null, 2) + '\n');
console.log(`\nSaved to ${fixturePath}`);
