// The popularity stage: played artists plus the top K catalog artists; top recordings become tracks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as H from './helpers.mjs';
import { fakeClient, topRecording } from './lb-fake.mjs';
import { withArtistMbid } from './library.mjs';
import { ingestListens } from '../lib/sync.mjs';
import { matchPlays } from '../lib/match.mjs';
import { refreshGraph } from '../lib/graph.mjs';
import { refreshPopularity } from '../lib/popularity.mjs';

const P = 'b0000000-0000-4000-8000-000000000001';
const X1 = 'b0000000-0000-4000-8000-000000000011';
const X2 = 'b0000000-0000-4000-8000-000000000012';
const X3 = 'b0000000-0000-4000-8000-000000000013';
const R1 = 'c0000000-0000-4000-8000-000000000001';

async function library(catalogTopK) {
  const { handle } = await H.freshDb();
  const db = handle.main;
  ingestListens(db, [withArtistMbid(H.listen({ at: 1000, msid: 'p1', artist: 'Played', title: 'Mine' }), P)]);
  matchPlays(db);
  const client = fakeClient({
    similar: { [P]: [X1, X2, X3].map((m, i) => ({ artist_mbid: m, name: `Catalog ${i + 1}`, score: 10 - i })) },
    tops: { [X1]: [topRecording({ artistMbid: X1, artist: 'Catalog 1', mbid: R1, title: 'Never Heard' })] },
  });
  await refreshGraph(db, client, { nowSec: 100 });
  const r = await refreshPopularity(db, client, { nowSec: 100, catalogTopK });
  return { db, handle, client, r };
}

test('top recordings are fetched for played artists and the top K catalog artists only', async () => {
  const { db, handle, client, r } = await library(2);
  try {
    const artistByMbid = (m) => db.prepare(`SELECT id FROM artist WHERE mbid=?`).get(m).id;
    const asked = client.fetch.calls.filter((c) => c.path.startsWith('/1/popularity/top-recordings-for-artist/')).map((c) => decodeURIComponent(c.path.split('/').pop()));
    assert.deepEqual(asked.sort(), [P, X1, X2].sort());
    assert.deepEqual(r.requests, { popularity: 1, top_recordings: 3 });
    assert.equal(r.catalog_artists, 2);
    const posted = JSON.parse(client.fetch.calls.find((c) => c.path === '/1/popularity/artist').body).artist_mbids;
    assert.deepEqual(posted.sort(), [P, X1, X2].sort());
    const pop = db.prepare(`SELECT artist_id FROM artist_popularity ORDER BY artist_id`).all().map((x) => x.artist_id);
    assert.deepEqual(pop, [P, X1, X2].map(artistByMbid).sort((a, b) => a - b));
  } finally {
    handle.close();
  }
});

test('an unknown top recording enters the DB, credited to its artist', async () => {
  const { db, handle, r } = await library(2);
  try {
    assert.equal(r.recordings, 1);
    const t = db.prepare(
      `SELECT t.title, a.mbid AS artist FROM track t JOIN track_artist ta ON ta.track_id = t.id AND ta.position = 0
       JOIN artist a ON a.id = ta.artist_id WHERE t.mbid=?`,
    ).get(R1);
    assert.deepEqual({ ...t }, { title: 'Never Heard', artist: X1 });
  } finally {
    handle.close();
  }
});

test('a failed top-recordings fetch is counted and the stage says partial', async () => {
  const { handle } = await H.freshDb();
  const db = handle.main;
  try {
    ingestListens(db, [withArtistMbid(H.listen({ at: 1000, msid: 'p1', artist: 'Played', title: 'Mine' }), P)]);
    matchPlays(db);
    const r = await refreshPopularity(db, fakeClient({ fail: { tops: [P] } }), { nowSec: 100 });
    assert.equal(r.tops.failed, 1);
    assert.equal(r.failed, 1);
    assert.equal(r.partial, true);
  } finally {
    handle.close();
  }
});

test('a refresh with a partial stage is recorded, and status marks it 暫定', async () => {
  const { handle } = await H.freshDb();
  try {
    ingestListens(handle.main, [withArtistMbid(H.listen({ at: 1000, msid: 'p1', artist: 'Played', title: 'Mine' }), P)]);
    matchPlays(handle.main);
    const { refresh } = await import('../lib/refresh.mjs');
    const { status } = await import('../lib/status.mjs');
    const r = await refresh(handle, { client: fakeClient({ fail: { similar: [P] } }), nowSec: 100, listensFullHistory: true });
    assert.equal(r.ok, true);
    assert.equal(handle.main.prepare(`SELECT value FROM meta WHERE key='refresh_note'`).get().value, 'stage graph partial: 1 LB requests failed');
    const st = status(handle);
    assert.equal(st.provisional, true);
    assert.match(st.provisional_note, /^暫定: the last refresh was incomplete/);
  } finally {
    handle.close();
  }
});

test('only the kept top recordings are cached, not the whole LB list', async () => {
  const { refresh } = await import('../lib/refresh.mjs');
  const { TOP_RECORDINGS_KEPT } = await import('../lib/popularity.mjs');
  const A = '55555555-5555-4555-8555-555555555555';
  const rows = Array.from({ length: TOP_RECORDINGS_KEPT + 5 }, (_, i) =>
    topRecording({ artistMbid: A, artist: 'Many', mbid: `eeeeeeee-eeee-4eee-8eee-${String(i).padStart(12, '0')}`, title: `T${i}`, listens: 1000 - i }));
  const client = fakeClient({ listens: [withArtistMbid(H.listen({ at: 1_700_000_000, msid: 'x', artist: 'Many', title: 'T0' }), A)], tops: { [A]: rows } });
  const { handle } = await H.freshDb({ client });
  try {
    assert.equal((await refresh(handle, { client, skipTokenCheck: true, listensFullHistory: true })).ok, true);
    const body = JSON.parse(handle.main.prepare(`SELECT body FROM fetch_cache WHERE endpoint='lb:top-recordings' AND key=?`).get(A).body);
    assert.equal(body.length, TOP_RECORDINGS_KEPT);
    assert.deepEqual(body.map((r) => r.recording_name), rows.slice(0, TOP_RECORDINGS_KEPT).map((r) => r.recording_name));
  } finally {
    handle.close();
  }
});
