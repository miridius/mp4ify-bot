const getRequiredEnv = (name: string) => {
  const value = Bun.env[name];
  if (!value) throw new Error(`${name} env var is required`);
  return value;
};

export const botToken = getRequiredEnv('BOT_TOKEN');

export const apiRoot = Bun.env.API_ROOT || 'http://bot-api:8081';

// a chat the bot is in, where inline queries upload their file for a file_id
export const INLINE_CACHE_CHAT_ID = Number(
  Bun.env.INLINE_CACHE_CHAT_ID || -4640446184,
);

// Per-bot like BLOB_DIR: dev and prod share the /storage volume, and each
// bot's boot sweep clears only its own staging tree, so one bot can't delete
// the other's in-flight download.
export const STAGING_DIR = Bun.env.STAGING_DIR || '/storage/staging';
