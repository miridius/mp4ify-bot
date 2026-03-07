import Anthropic from '@anthropic-ai/sdk';

const defaultClient = new Anthropic();

export type Classification = 'article' | 'video';

/**
 * Ask Claude Haiku whether a URL looks like a news article or a video.
 * Returns 'article' or 'video'.
 */
export const classifyUrl = async (
  url: string,
  title?: string,
  client: Anthropic = defaultClient,
): Promise<Classification> => {
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1,
    messages: [
      {
        role: 'user',
        content: `Is this URL a news article/blog post, or a video/media page? Reply with exactly one word: "article" or "video".

URL: ${url}${title ? `\nPage title: ${title}` : ''}`,
      },
    ],
  });
  const text =
    msg.content[0]?.type === 'text' ? msg.content[0].text.trim().toLowerCase() : '';
  return text === 'article' ? 'article' : 'video';
};
