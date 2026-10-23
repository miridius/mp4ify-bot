import { copyFile } from 'fs/promises';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { isNotFound, unlinkQuiet } from './fs-utils';
import { isOnHost } from './utils';

// Netscape cookies.txt: Reddit redirects logged-out requests from our IP to
// login. Shared by both bots: they log in as the same account.
export const COOKIES_FILE = '/storage/mp4ify-cookies.txt';

export const REDDIT_HOSTS: readonly string[] = ['reddit.com', 'redd.it'];

// yt-dlp reads its config from the --paths home dir, and downloads set that
// to a staging dir
export const YTDLP_CONFIG_ARGS: readonly string[] = [
  '--ignore-config',
  '--config-locations',
  resolve(import.meta.dir, '../yt-dlp.conf'),
];

// yt-dlp saves its whole jar back to the --cookies file on exit, so each run
// gets a private copy: runs would otherwise race on one file, and every site's
// cookies would pile up in it
export const withCookies = async <T>(run: (cookieArgs: string[]) => Promise<T>) => {
  const copy = `${tmpdir()}/cookies-${crypto.randomUUID()}.txt`;
  let cookieArgs: string[] = [];
  try {
    await copyFile(COOKIES_FILE, copy);
    cookieArgs = ['--cookies', copy];
  } catch (e) {
    // the cookies only serve the sites that demand a login, so a broken file
    // must not fail every other site's runs too
    if (!isNotFound(e))
      console.error(`Running yt-dlp without cookies: copying ${COOKIES_FILE} failed:`, e);
  }
  try {
    return await run(cookieArgs);
  } finally {
    await unlinkQuiet(copy);
  }
};

// Reddit blocks yt-dlp's own fingerprint from this server, even logged in.
// Impersonating elsewhere would send Chrome's fingerprint under YouTube
// clients' own User-Agents, and make every run depend on curl_cffi (a Reddit
// post linking to YouTube still gets it for the scrape)
export const impersonateArgs = (url: string) =>
  isOnHost(url, REDDIT_HOSTS) ? ['--impersonate', 'chrome'] : [];
