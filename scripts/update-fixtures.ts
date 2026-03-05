/**
 * Fetches real yt-dlp data for each service in video-info-duration.json
 * and updates the fixture file with current values.
 *
 * Run via: docker compose run --rm --no-deps test bun scripts/update-fixtures.ts
 */

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
  const proc = Bun.spawn(
    ['yt-dlp', entry.url, '--dump-json', '--no-warnings', '--no-check-certificates'],
    { stderr: 'pipe', timeout: 60000 },
  );
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0 || !stdout.trim()) {
    console.error(`  FAILED: ${stderr.trim() || 'no output'}`);
    continue;
  }

  let info;
  try {
    info = JSON.parse(stdout);
  } catch (e: any) {
    console.error(`  FAILED to parse JSON: ${e.message}`);
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
