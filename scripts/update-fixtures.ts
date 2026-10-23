/**
 * Fetches real yt-dlp data for each service in video-info-duration.json
 * and updates the fixture file with current values.
 *
 * Run via ./learning-test.sh, which lends it the prod bot's Reddit cookie jar.
 */
import { fetchInfo } from '../test/ytdlp-live';

const fixturePath = 'test/fixtures/video-info-duration.json';
const fixtures = await Bun.file(fixturePath).json();
const fields = ['extractor', 'duration', 'duration_string', 'is_live', 'was_live'] as const;

let hasChanges = false;

for (const [service, entry] of Object.entries<any>(fixtures.services)) {
  if (!entry.url) {
    console.log(`Skipping ${service} (no url)`);
    continue;
  }

  console.log(`Fetching ${service}: ${entry.url}`);
  let info;
  try {
    info = await fetchInfo(entry.url);
  } catch (e: any) {
    console.error(`  FAILED: ${e.message}`);
    continue;
  }
  let serviceChanged = false;
  for (const field of fields) {
    const oldVal = entry[field];
    const newVal = info[field] ?? null;
    if (oldVal !== newVal) {
      console.log(`  ${field}: ${JSON.stringify(oldVal)} -> ${JSON.stringify(newVal)}`);
      entry[field] = newVal;
      hasChanges = true;
      serviceChanged = true;
    }
  }

  if (!serviceChanged) {
    console.log(`  OK (no changes)`);
  }
}

if (hasChanges) {
  await Bun.write(fixturePath, JSON.stringify(fixtures, null, 2) + '\n');
  console.log('\nFixtures updated.');
} else {
  console.log('\nAll fixtures already up to date.');
}
