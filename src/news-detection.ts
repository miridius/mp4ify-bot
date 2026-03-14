const NEWS_DOMAINS = new Set([
  'bbc.co.uk',
  'bbc.com',
  'cnn.com',
  'reuters.com',
  'theguardian.com',
  'washingtonpost.com',
  'nytimes.com',
  'apnews.com',
  'aljazeera.com',
  'nbcnews.com',
  'cbsnews.com',
  'abcnews.go.com',
  'foxnews.com',
  'npr.org',
  'bloomberg.com',
  'politico.com',
  'thehill.com',
  'sky.com',
  'news.sky.com',
  'france24.com',
  'dw.com',
  'spiegel.de',
  'independent.co.uk',
  'telegraph.co.uk',
  'mirror.co.uk',
  'news.com.au',
  'abc.net.au',
  'smh.com.au',
  'theatlantic.com',
  'newyorker.com',
  'propublica.org',
  'arstechnica.com',
  'theverge.com',
  'wired.com',
]);

const NEWS_EXTRACTORS = new Set([
  'bbc',
  'bbc.co.uk',
  'bbc.co.uk:article',
  'cnn',
  'abcnews',
  'cbsnews',
  'foxnews',
  'foxnews:article',
  'nbcnews',
  'aljazeera',
  'washingtonpost',
  'washingtonpost:article',
  'bloomberg',
  'spiegel',
]);

const NEWS_DOMAINS_ARRAY = [...NEWS_DOMAINS];

const matchesDomain = (hostname: string): boolean => {
  const host = hostname.replace(/^www\./, '');
  if (NEWS_DOMAINS.has(host)) return true;
  return NEWS_DOMAINS_ARRAY.some((domain) => host.endsWith('.' + domain));
};

export const isNewsUrl = (url: string, extractor?: string): boolean => {
  if (extractor && NEWS_EXTRACTORS.has(extractor.toLowerCase())) return true;
  try {
    const hostname = new URL(url).hostname;
    return matchesDomain(hostname);
  } catch {
    return false;
  }
};
