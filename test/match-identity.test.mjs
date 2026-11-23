// Which track a play belongs to, and keeping that answer current when LB data changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, listen } from './helpers.mjs';
import { ingestListens } from '../lib/sync.mjs';
import { matchPlays, registerCatalogRecording } from '../lib/match.mjs';

const M1 = '11111111-1111-4111-8111-111111111111';
const M2 = '22222222-2222-4222-8222-222222222222';

const trackOf = (db, msid) => db.prepare(`SELECT track_id FROM play WHERE source_key LIKE ?`).get(`%${msid}%`).track_id;

async function withDb(fn) {
  const { handle } = await freshDb();
  try { await fn(handle.main); } finally { handle.close(); }
}

test('an ID-less play of a song already played with an MBID joins that track', () => withDb((db) => {
  ingestListens(db, [listen({ at: 1000, msid: 'with-mbid', artist: 'Band', title: 'Song', mbid: M1, via: 'spotify' })]);
  matchPlays(db);
  ingestListens(db, [listen({ at: 9000, msid: 'no-ids', artist: 'Band', title: 'Song' })]);
  matchPlays(db);
  assert.equal(trackOf(db, 'no-ids'), trackOf(db, 'with-mbid'));
  assert.equal(db.prepare(`SELECT count(*) AS n FROM track`).get().n, 1);
}));

test('an ID-less play does not name-match a recording known only from the LB catalog', () => withDb((db) => {
  ingestListens(db, [listen({ at: 1000, msid: 'seed', artist: 'Band', title: 'Song', mbid: M1 })]);
  matchPlays(db);
  const artistId = db.prepare(`SELECT artist_id FROM play`).get().artist_id;
  const catalog = registerCatalogRecording(db, artistId, { recording_mbid: M2, recording_name: 'Other', artist_name: 'Band' }).id;
  ingestListens(db, [listen({ at: 9000, msid: 'no-ids', artist: 'Band', title: 'Other' })]);
  matchPlays(db);
  assert.notEqual(trackOf(db, 'no-ids'), catalog);
}));

test('an ID-less play with an ISRC does not join a played MBID track whose ISRCs differ', () => withDb((db) => {
  ingestListens(db, [listen({ at: 1000, msid: 'with-mbid', artist: 'Band', title: 'Song', mbid: M1, isrc: 'USAAA0000001' })]);
  matchPlays(db);
  ingestListens(db, [listen({ at: 9000, msid: 'other-isrc', artist: 'Band', title: 'Song', isrc: 'USBBB0000002' })]);
  matchPlays(db);
  assert.notEqual(trackOf(db, 'other-isrc'), trackOf(db, 'with-mbid'));
}));

// ---- canonical pairs follow the IDs LB gives later ----

import { defaultStages } from '../lib/refresh.mjs';
import { dedupPlays } from '../lib/match.mjs';

async function matchStage(handle) {
  return defaultStages(handle, { client: {}, skipTokenCheck: true }).find((s) => s.name === 'match').run();
}

const pairFixture = (mapped = {}) => [
  listen({ at: 1000, msid: 'via-lastfm', artist: 'Band', title: 'Song', via: 'lastfm', mapped: mapped.a }),
  listen({ at: 1010, msid: 'via-spotify', artist: 'Band', title: 'Song', via: 'spotify', mapped: mapped.b }),
];
const roots = (db) => db.prepare(`SELECT count(*) AS n FROM play WHERE canonical_play_id IS NULL`).get().n;

test('a name-deduped pair is undone when LB later maps the two plays to different MBIDs', async () => {
  const { handle } = await freshDb();
  const db = handle.main;
  try {
    ingestListens(db, pairFixture());
    await matchStage(handle);
    assert.equal(roots(db), 1);
    ingestListens(db, pairFixture({ a: M1, b: M2 }));
    const r = await matchStage(handle);
    assert.equal(r.unpaired, 1);
    assert.equal(roots(db), 2);
    assert.notEqual(trackOf(db, 'via-lastfm'), trackOf(db, 'via-spotify'));
    assert.equal(db.prepare(`SELECT count(*) AS n FROM play WHERE track_id IS NULL`).get().n, 0);
  } finally {
    handle.close();
  }
});

test('a pair whose plays gain the same MBID stays paired', async () => {
  const { handle } = await freshDb();
  const db = handle.main;
  try {
    ingestListens(db, pairFixture());
    await matchStage(handle);
    ingestListens(db, pairFixture({ a: M1, b: M1 }));
    const r = await matchStage(handle);
    assert.equal(r.unpaired, 0);
    assert.equal(roots(db), 1);
    assert.equal(dedupPlays(db).paired, 0);
  } finally {
    handle.close();
  }
});
