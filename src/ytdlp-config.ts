import { resolve } from 'path';

// yt-dlp reads its config from the --paths home dir, and downloads set that
// to a staging dir
export const YTDLP_CONFIG_ARGS: readonly string[] = [
  '--ignore-config',
  '--config-locations',
  resolve(import.meta.dir, '../yt-dlp.conf'),
];
