import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshDb, listen } from './helpers.mjs';
import { fakeClient } from './lb-fake.mjs';

const listenCalls = (client) => client.fetch.calls.filter((c) => c.path.endsWith('/listens')).map((c) => c.params);
import { nomssidFrom, listenToPlayFields } from '../lib/listenbrainz.mjs';
import { normalizeArtist, normalizeTitle } from '../lib/normalize.mjs';
import {
  syncListens,
  parseListenBrainzExport,
  loadListenBrainzExport,
  DELTA_OVERLAP_SEC,
  META_LISTENS_MAX_TS,
  lastSyncedListenTs,
} from '../lib/sync.mjs';
import { getMeta } from '../lib/db.mjs';
import { DjdbError } from '../lib/errors.mjs';
import { createHash } from 'node:crypto';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'listens-export.json');
const GOLD_BEATLES = 'nomssid:749b9ace4b597451539ff79af005cf9f';
const GOLD_EMPTY = 'nomssid:3a6d49d013713694c351e26fc2282c5c';

function expectedNomssid(listenedAt, meta = {}) {
  const payload = [
    String(Number(listenedAt)),
    normalizeArtist(meta.artist_name || ''),
    normalizeTitle(meta.track_name || ''),
    normalizeTitle(meta.release_name || ''),
  ].join('|');
  const hex = createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 32);
  return { key: `nomssid:${hex}`, payload };
}

test('nomssidFrom is stable and follows the documented hash inputs', () => {
  const meta = { artist_name: 'The Beatles', track_name: 'Let It Be', release_name: 'Let It Be' };
  const { key, payload } = expectedNomssid(1_700_000_000, meta);
  assert.equal(payload, '1700000000|beatles|let it be|let it be');
  assert.equal(nomssidFrom(1_700_000_000, meta), GOLD_BEATLES);
  assert.equal(key, GOLD_BEATLES);

  // Same listened_at + normalized names: raw capitalization and punctuation do not change the key.
  assert.equal(
    nomssidFrom(1_700_000_000, { artist_name: 'THE BEATLES', track_name: 'Let It Be!', release_name: 'let it be' }),
    GOLD_BEATLES,
  );
  assert.equal(nomssidFrom('1700000000', meta), GOLD_BEATLES);

  assert.equal(nomssidFrom(1, {}), GOLD_EMPTY);
  assert.notEqual(nomssidFrom(1_700_000_001, meta), GOLD_BEATLES);
  assert.notEqual(
    nomssidFrom(1_700_000_000, { ...meta, track_name: 'Let It Be (Remastered)' }),
    GOLD_BEATLES,
  );

  const fields = listenToPlayFields({
    listened_at: 1_700_000_000,
    track_metadata: meta,
  });
  assert.equal(fields.source_key, `lb:1700000000|${GOLD_BEATLES}`);
});

test('parseListenBrainzExport accepts array, payload.listens, listens, payload[], and JSONL', () => {
  const one = listen({ at: 10, msid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', artist: 'A', title: 'T' });
  assert.equal(parseListenBrainzExport([one]).length, 1);
  assert.equal(parseListenBrainzExport({ listens: [one] }).length, 1);
  assert.equal(parseListenBrainzExport({ payload: { listens: [one] } }).length, 1);
  assert.equal(parseListenBrainzExport({ payload: [one] }).length, 1);
  assert.equal(parseListenBrainzExport(JSON.stringify({ listens: [one] })).length, 1);
  assert.equal(parseListenBrainzExport(JSON.stringify(one) + '\n' + JSON.stringify(one) + '\n').length, 2);
  const loaded = loadListenBrainzExport(FIXTURE);
  assert.equal(loaded.length, 3);
  assert.throws(() => parseListenBrainzExport({ no: 'listens' }), (e) => e instanceof DjdbError && e.code === 'lb_export_invalid');
});

test('first listen sync requires an export or --listens-full-history', async () => {
  const client = fakeClient({ listens: [listen({ at: 1_700_000_000, msid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', artist: 'A', title: 'T' })] });
  const { handle } = await freshDb({ client });
  try {
    assert.equal(lastSyncedListenTs(handle.main), null);
    await assert.rejects(
      () => syncListens(handle.main, client, 'tester'),
      (e) => e instanceof DjdbError && e.code === 'lb_export_required',
    );
    assert.equal(listenCalls(client).length, 0);
    assert.equal(handle.main.prepare('SELECT count(*) AS n FROM play').get().n, 0);
  } finally {
    handle.close();
  }
});

test('first listen sync imports the export and does not page /listens', async () => {
  const client = fakeClient({
    listens: [listen({ at: 1_800_000_000, msid: 'cccccccccccccccccccccccccccccccccccc', artist: 'Should Not Fetch', title: 'X' })],
  });
  const { handle } = await freshDb({ client });
  try {
    const r = await syncListens(handle.main, client, 'tester', { exportFile: FIXTURE });
    assert.equal(r.source, 'export');
    assert.equal(r.inserted, 3);
    assert.equal(r.fetched, 3);
    assert.equal(listenCalls(client).length, 0);
    assert.equal(handle.main.prepare('SELECT count(*) AS n FROM play').get().n, 3);
    assert.equal(getMeta(handle.main, META_LISTENS_MAX_TS), '1700000200');
    assert.equal(lastSyncedListenTs(handle.main), 1_700_000_200);
    const noMsid = handle.main.prepare(`SELECT source_key FROM play WHERE played_at=1700000200`).get();
    const expected = listenToPlayFields({
      listened_at: 1_700_000_200,
      track_metadata: { artist_name: 'The Beatles', track_name: 'Let It Be', release_name: 'Let It Be' },
    });
    assert.equal(noMsid.source_key, expected.source_key);
    assert.match(noMsid.source_key, /^lb:1700000200\|nomssid:[0-9a-f]{32}$/);
  } finally {
    handle.close();
  }
});

test('subsequent sync uses min_ts with overlap and UNIQUE(source_key) absorbs duplicates', async () => {
  const last = 1_700_000_200;
  const overlapListen = {
    listened_at: last,
    track_metadata: {
      artist_name: 'The Beatles',
      track_name: 'Let It Be',
      release_name: 'Let It Be',
    },
  };
  const newListen = listen({
    at: last + 50,
    msid: '33333333-3333-3333-3333-333333333333',
    artist: 'New Artist',
    title: 'New Track',
  });
  const tooOld = listen({
    at: last - DELTA_OVERLAP_SEC - 10,
    msid: '44444444-4444-4444-4444-444444444444',
    artist: 'Too Old',
    title: 'Skipped',
  });
  const client = fakeClient({ listens: [tooOld, overlapListen, newListen] });
  const { handle } = await freshDb({ client });
  try {
    await syncListens(handle.main, client, 'tester', { exportFile: FIXTURE });
    assert.equal(listenCalls(client).length, 0);
    const before = handle.main.prepare('SELECT count(*) AS n FROM play').get().n;
    assert.equal(before, 3);

    const r = await syncListens(handle.main, client, 'tester');
    assert.equal(r.source, 'listens-delta');
    assert.equal(r.min_ts, last - DELTA_OVERLAP_SEC);
    assert.equal(listenCalls(client).length, 1);
    assert.equal(listenCalls(client)[0].min_ts, String(last - DELTA_OVERLAP_SEC));
    assert.equal(listenCalls(client)[0].max_ts, undefined);
    // overlap dup absorbed; too-old filtered; only the new listen is inserted
    assert.equal(r.inserted, 1);
    assert.equal(handle.main.prepare('SELECT count(*) AS n FROM play').get().n, 4);
    assert.equal(getMeta(handle.main, META_LISTENS_MAX_TS), String(last + 50));
  } finally {
    handle.close();
  }
});

test('--listens-full-history pages /listens with no min_ts when an export is unavailable', async () => {
  const listens = [
    listen({ at: 1_100_000_000, msid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', artist: 'A', title: 'One' }),
    listen({ at: 1_200_000_000, msid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', artist: 'A', title: 'Two' }),
  ];
  const client = fakeClient({ listens });
  const { handle } = await freshDb({ client });
  try {
    const r = await syncListens(handle.main, client, 'tester', { listensFullHistory: true });
    assert.equal(r.source, 'listens-full');
    assert.equal(r.inserted, 2);
    assert.equal(listenCalls(client).length, 1);
    assert.equal(listenCalls(client)[0].min_ts, undefined);
    assert.equal(getMeta(handle.main, META_LISTENS_MAX_TS), '1200000000');
  } finally {
    handle.close();
  }
});

test('an already-filled DB without meta uses max(played_at) and does not demand an export', async () => {
  const client = fakeClient({
    listens: [listen({ at: 1_700_000_300, msid: '55555555-5555-5555-5555-555555555555', artist: 'Delta', title: 'D' })],
  });
  const { handle } = await freshDb({ client });
  try {
    await syncListens(handle.main, client, 'tester', { exportFile: FIXTURE });
    handle.main.prepare('DELETE FROM meta WHERE key=?').run(META_LISTENS_MAX_TS);
    assert.equal(getMeta(handle.main, META_LISTENS_MAX_TS) ?? null, null);
    assert.equal(lastSyncedListenTs(handle.main), 1_700_000_200);
    const r = await syncListens(handle.main, client, 'tester');
    assert.equal(r.source, 'listens-delta');
    assert.equal(r.min_ts, 1_700_000_200 - DELTA_OVERLAP_SEC);
    assert.equal(r.inserted, 1);
  } finally {
    handle.close();
  }
});
