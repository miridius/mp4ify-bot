/**
 * Captures yt-dlp output for news article URLs to understand how the generic
 * extractor behaves. Run: bun scripts/capture-ytdlp-article-fixture.ts
 *
 * Some articles may error out (no video found), which is also useful data.
 */

const fixturePath = 'test/fixtures/ytdlp-article.json';

const articleUrls: Record<string, string> = {
  bbc_news: 'https://www.bbc.com/news/world-us-canada-61377951',
  arstechnica: 'https://arstechnica.com/science/2024/04/nasas-voyager-1-starts-talking-to-us-again/',
  cnn_with_video: 'https://www.cnn.com/2024/04/08/weather/total-solar-eclipse-monday/index.html',
};

const fields = ['extractor', 'extractor_key', 'webpage_url', 'title', 'duration', 'duration_string', 'is_live', 'was_live'] as const;

const results: Record<string, any> = {};

for (const [name, url] of Object.entries(articleUrls)) {
  console.log(`Fetching ${name}: ${url}`);
  const proc = Bun.spawn(
    ['yt-dlp', url, '--dump-json', '--no-warnings', '--no-check-certificates', '--no-download'],
    { stderr: 'pipe', timeout: 60000 },
  );
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0 || !stdout.trim()) {
    console.log(`  ERROR (exit ${exitCode}): ${stderr.trim().split('\n')[0]}`);
    results[name] = {
      url,
      error: stderr.trim().split('\n')[0],
      exitCode,
      note: 'yt-dlp could not extract video from this article',
    };
    continue;
  }

  try {
    const info = JSON.parse(stdout);
    const captured: Record<string, any> = { url };
    for (const field of fields) {
      captured[field] = info[field] ?? null;
    }
    console.log(`  extractor: ${info.extractor}, title: ${info.title?.slice(0, 60)}`);
    results[name] = captured;
  } catch (e: any) {
    console.error(`  FAILED to parse JSON: ${e.message}`);
    results[name] = { url, error: `JSON parse error: ${e.message}` };
  }
}

await Bun.write(
  fixturePath,
  JSON.stringify(
    {
      description: 'yt-dlp output for news article URLs. Run: bun scripts/capture-ytdlp-article-fixture.ts',
      articles: results,
    },
    null,
    2,
  ) + '\n',
);
console.log(`\nSaved to ${fixturePath}`);
