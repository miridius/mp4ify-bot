import { $ } from 'bun';
import { randomBytes } from 'node:crypto';

export const hostname = (await $`hostname`.text()).trim(); // getRequiredEnv('HOSTNAME');

export const secret = randomBytes(32).toString('hex');

const getRequiredEnv = (name: string) => {
  const value = Bun.env[name];
  if (!value) throw new Error(`${name} env var is required`);
  return value;
};
``;
export const botToken = getRequiredEnv('BOT_TOKEN');

export const apiRoot = Bun.env.API_ROOT || 'http://bot-api:8081';

// Parent of the per-download staging homes (downloadVideo gives each yt-dlp
// run its own dir under here via `--paths home:`, which beats the conf's
// home; verified against the real yt-dlp). Per-bot like BLOB_DIR: dev and
// prod share the /storage volume, and each bot's boot sweep clears only its
// own staging tree, so one bot can't delete the other's in-flight download.
export const STAGING_DIR = Bun.env.STAGING_DIR || '/storage/staging';
