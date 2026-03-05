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
  postDownload: boolean;
};

const file = (id: string) => Bun.file(`${PENDING_DIR}${id}.json`);

const isNotFound = (e: unknown) =>
  e instanceof Error && 'code' in e && e.code === 'ENOENT';

export const addPending = async (download: PendingDownload): Promise<string> => {
  const id = crypto.randomUUID();
  await Bun.write(file(id), JSON.stringify(download));
  return id;
};

export const putPending = async (id: string, download: PendingDownload): Promise<void> => {
  await Bun.write(file(id), JSON.stringify(download));
};

export const getPending = async (id: string): Promise<PendingDownload | undefined> => {
  try {
    return await file(id).json();
  } catch (e) {
    if (!isNotFound(e)) console.error(`getPending(${id}) failed:`, e);
    return undefined;
  }
};

export const takePending = async (id: string): Promise<PendingDownload | undefined> => {
  const f = file(id);
  try {
    const entry: PendingDownload = await f.json();
    await f.unlink();
    return entry;
  } catch (e) {
    if (!isNotFound(e)) console.error(`takePending(${id}) failed:`, e);
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
