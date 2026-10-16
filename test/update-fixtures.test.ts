import { afterAll, beforeEach, expect, it } from 'bun:test';
import { rm } from 'fs/promises';
import fixtures from './fixtures/video-info-duration.json';
import { resetStub, STUB_DIR, stub } from './test-utils';

beforeEach(resetStub);
afterAll(() => rm(STUB_DIR, { recursive: true, force: true }));

it('exits non-zero when the fetches fail', async () => {
  await stub({ exit: '1', stderr: 'ERROR: Unable to download webpage\n' });
  const proc = Bun.spawn(['bun', 'scripts/update-fixtures.ts'], {
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const stderr = await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(2);
  expect(stderr).toContain(
    `Fetch failed for: ${Object.keys(fixtures.services).join(', ')}`,
  );
});
