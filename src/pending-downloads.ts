import { mkdir, readdir, unlink } from 'fs/promises';
import type { VideoInfo } from './download-video';

export const LONG_VIDEO_THRESHOLD_SECS = 20 * 60;
const PENDING_DIR = '/storage/_pending-downloads/';
await mkdir(PENDING_DIR, { recursive: true });

export type PendingDownload = {
  info: VideoInfo;
  verbose: boolean;
  messageId: number;
  chatId: number;
  userId: number;
  postDownload?: boolean;
};

const file = (id: string) => Bun.file(`${PENDING_DIR}${id}.json`);

export const addPending = async (download: PendingDownload): Promise<string> => {
  const id = Math.random().toString(36).slice(2, 10);
  await Bun.write(file(id), JSON.stringify(download));
  return id;
};

export const putPending = async (id: string, download: PendingDownload): Promise<void> => {
  await Bun.write(file(id), JSON.stringify(download));
};

export const getPending = async (id: string): Promise<PendingDownload | undefined> => {
  try {
    return await file(id).json();
  } catch {
    return undefined;
  }
};

export const takePending = async (id: string): Promise<PendingDownload | undefined> => {
  try {
    const entry: PendingDownload = await file(id).json();
    await file(id).unlink();
    return entry;
  } catch {
    return undefined;
  }
};

export const clearPending = async () => {
  try {
    await Promise.all(
      (await readdir(PENDING_DIR)).map((name) => unlink(`${PENDING_DIR}${name}`)),
    );
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
  }
};
