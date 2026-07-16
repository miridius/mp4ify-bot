// The migrator against a scratch DB: the shared connection's migrations ran
// at import time, so era-transition behavior (data fixes applying to rows the
// PRIOR schema wrote) is only testable by replaying MIGRATIONS from zero.
import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { migrate, MIGRATIONS } from '../src/db';

const userVersion = (db: Database) =>
  (db.query('PRAGMA user_version').get() as { user_version: number })
    .user_version;

describe('migrations', () => {
  it('apply cleanly from zero to head', () => {
    const db = new Database(':memory:');
    migrate(db);
    expect(userVersion(db)).toBe(MIGRATIONS.length);
  });

  it('the generic-key fix drops era rows without touching live ones', () => {
    // seed as a pre-fix era did: blobs keyed by the generic extractor, which
    // post-fix code can never address again (blobKey excludes generic)
    const db = new Database(':memory:');
    migrate(db, 2);
    const insert = db.query(
      'INSERT INTO blobs (key, path, created_at) VALUES (?, ?, ?)',
    );
    insert.run('generic:video:0', '/storage/blobs/g.mp4', Date.now());
    insert.run('yt:abc:137', '/storage/blobs/y.mp4', Date.now());

    migrate(db);

    const keys = db
      .query('SELECT key FROM blobs ORDER BY key')
      .all() as { key: string }[];
    expect(keys).toEqual([{ key: 'yt:abc:137' }]);
  });

  it('backfills the webpage_url column from a v3-era JSON-only row', () => {
    // migration 4 replaces the expression index with a real column; a row the
    // v3 schema wrote has only the JSON payload, so the migration must extract
    // and denormalize its webpage_url into the new column
    const db = new Database(':memory:');
    migrate(db, 4);
    db.query('INSERT INTO video_info (url, info, created_at) VALUES (?, ?, ?)').run(
      'https://alias.example',
      JSON.stringify({ webpage_url: 'https://canonical.example', title: 'T' }),
      Date.now(),
    );

    migrate(db);

    const row = db
      .query('SELECT webpage_url FROM video_info WHERE url = ?')
      .get('https://alias.example') as { webpage_url: string };
    expect(row.webpage_url).toBe('https://canonical.example');
  });
});
