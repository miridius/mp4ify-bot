import { YTDLP_CONFIG_ARGS } from '../src/ytdlp-config';

// public, and YouTube withholds it from yt-dlp without a JS runtime
export const MADE_FOR_KIDS_VIDEO = 'https://youtu.be/T3eBoD8H3Xg';

const run = async (args: string[]) => {
  const proc = Bun.spawn(['yt-dlp', ...args], {
    stderr: 'pipe',
    timeout: 100000, // under the live cases' 120s, so a hang fails with yt-dlp's stderr
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if ((await proc.exited) !== 0) throw new Error(`yt-dlp failed: ${stderr.trim()}`);
  return { stdout, stderr };
};

export const ytdlpWith = async (config: readonly string[], ...args: string[]) =>
  (await run([...args, '--no-warnings', ...config])).stdout;

export const ytdlp = (...args: string[]) => ytdlpWith(YTDLP_CONFIG_ARGS, ...args);

export const fetchInfo = async (url: string) => {
  // warnings kept: they are an empty dump's only explanation
  const { stdout, stderr } = await run([
    url,
    '--dump-json',
    '--no-check-certificates',
    ...YTDLP_CONFIG_ARGS,
  ]);
  if (!stdout.trim()) {
    throw new Error(`yt-dlp returned no output for ${url}: ${stderr.trim()}`);
  }
  return JSON.parse(stdout);
};
