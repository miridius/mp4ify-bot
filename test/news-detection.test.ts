import { describe, expect, it } from 'bun:test';
import { isNewsUrl } from '../src/news-detection';

describe('isNewsUrl', () => {
  it('detects known news domains', () => {
    expect(isNewsUrl('https://bbc.co.uk/news/article')).toBe(true);
    expect(isNewsUrl('https://cnn.com/2024/story')).toBe(true);
    expect(isNewsUrl('https://reuters.com/world/something')).toBe(true);
    expect(isNewsUrl('https://theguardian.com/uk-news')).toBe(true);
    expect(isNewsUrl('https://nytimes.com/article')).toBe(true);
  });

  it('detects subdomains of news domains', () => {
    expect(isNewsUrl('https://www.bbc.co.uk/news/article')).toBe(true);
    expect(isNewsUrl('https://edition.cnn.com/2024/story')).toBe(true);
    expect(isNewsUrl('https://www.reuters.com/world')).toBe(true);
    expect(isNewsUrl('https://news.sky.com/story')).toBe(true);
  });

  it('does not flag non-news domains', () => {
    expect(isNewsUrl('https://youtube.com/watch?v=123')).toBe(false);
    expect(isNewsUrl('https://tiktok.com/@user/video')).toBe(false);
    expect(isNewsUrl('https://reddit.com/r/videos')).toBe(false);
    expect(isNewsUrl('https://vimeo.com/12345')).toBe(false);
  });

  it('detects by extractor name', () => {
    expect(isNewsUrl('https://example.com', 'bbc.co.uk:article')).toBe(true);
    expect(isNewsUrl('https://example.com', 'CNN')).toBe(true);
    expect(isNewsUrl('https://example.com', 'Bloomberg')).toBe(true);
    expect(isNewsUrl('https://example.com', 'foxnews:article')).toBe(true);
  });

  it('returns false for non-news extractor', () => {
    expect(isNewsUrl('https://youtube.com/watch?v=123', 'youtube')).toBe(false);
    expect(isNewsUrl('https://tiktok.com/video', 'TikTok')).toBe(false);
  });

  it('handles invalid URLs gracefully', () => {
    expect(isNewsUrl('not-a-url')).toBe(false);
    expect(isNewsUrl('')).toBe(false);
  });
});
