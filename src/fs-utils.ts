import { unlink } from 'fs/promises';

const isNotFound = (e: unknown) =>
  e instanceof Error && 'code' in e && e.code === 'ENOENT';

// best-effort cleanup: unlink a file, tolerating "already gone" (ENOENT) but
// logging any other failure so a leftover that should have been removed stays
// visible.
export const unlinkQuiet = async (path: string) => {
  try {
    await unlink(path);
  } catch (e) {
    if (!isNotFound(e)) console.error(`Failed to clean up ${path}:`, e);
  }
};
