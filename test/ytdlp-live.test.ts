import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { rm } from 'fs/promises';
import { COOKIES_FILE, YTDLP_CONFIG_ARGS } from '../src/ytdlp-config';
import { cookiesArg, OWNS_COOKIE_JAR, resetStub, STUB_DIR, stub, stubArgs } from './test-utils';
import { fetchInfo, ytdlp, ytdlpWith } from './ytdlp-live';

beforeEach(resetStub);
afterAll(() => rm(STUB_DIR, { recursive: true, force: true }));

it('YTDLP_CONFIG_ARGS points at the repo yt-dlp.conf', async () => {
  const conf = YTDLP_CONFIG_ARGS[YTDLP_CONFIG_ARGS.indexOf('--config-locations') + 1]!;
  expect(await Bun.file(conf).exists()).toBe(true);
});

describe('live yt-dlp helpers', () => {
  it('passes the repo config and returns stdout', async () => {
    await stub({ stdout: '{"id":"x"}\n' });
    expect(await fetchInfo('https://example.com/v')).toEqual({ id: 'x' });
    expect(await stubArgs()).toEndWith(
      `https://example.com/v --dump-json --no-check-certificates ${YTDLP_CONFIG_ARGS.join(' ')}`,
    );
  });

  it('fetchInfo impersonates a browser for Reddit, like the bot', async () => {
    await stub({ stdout: '{"id":"x"}\n' });
    await fetchInfo('https://www.reddit.com/r/x/comments/abc/');
    expect(await stubArgs()).toEndWith(`${YTDLP_CONFIG_ARGS.join(' ')} --impersonate chrome`);
  });

  it.if(OWNS_COOKIE_JAR)("fetchInfo scrapes with a copy of the bot's cookie jar, like the bot", async () => {
    await Bun.write(COOKIES_FILE, '# Netscape HTTP Cookie File\n');
    try {
      await stub({ stdout: '{"id":"x"}\n' });
      await fetchInfo('https://example.com/v');
      const copy = (await cookiesArg())!;
      expect(copy).not.toBe(COOKIES_FILE);
      expect(await Bun.file(copy).exists()).toBe(false);
    } finally {
      await rm(COOKIES_FILE, { force: true });
    }
  });

  it('ytdlp runs with the repo config and returns stdout', async () => {
    await stub({ stdout: 'out\n' });
    expect(await ytdlp('--version')).toBe('out\n');
    expect(await stubArgs()).toEndWith(`--version --no-warnings ${YTDLP_CONFIG_ARGS.join(' ')}`);
  });

  it('fetchInfo throws, naming the url and stderr, when yt-dlp prints nothing', async () => {
    await stub({ stdout: '', stderr: 'WARNING: login required\n' });
    await expect(fetchInfo('https://example.com/v')).rejects.toThrow(
      'yt-dlp returned no output for https://example.com/v: WARNING: login required',
    );
  });

  it('throws with stderr on a failing run', async () => {
    await stub({ exit: '1', stderr: 'ERROR: nope\n' });
    await expect(ytdlpWith([], 'https://example.com/v')).rejects.toThrow(
      'yt-dlp failed: ERROR: nope',
    );
  });
});
