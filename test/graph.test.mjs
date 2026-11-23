// The graph stage: fetch into fetch_cache, then rebuild every edge from the cache in one transaction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as H from './helpers.mjs';
import { fakeClient } from './lb-fake.mjs';
import { withArtistMbid } from './library.mjs';
import { ingestListens } from '../lib/sync.mjs';
import { matchPlays } from '../lib/match.mjs';
import { refreshGraph } from '../lib/graph.mjs';
import { recommend } from '../lib/recommend.mjs';

const A = 'a0000000-0000-4000-8000-000000000001';
const B = 'a0000000-0000-4000-8000-000000000002';
const C = 'a0000000-0000-4000-8000-000000000003';
const X = 'a0000000-0000-4000-8000-0000000000ff';

async function threeArtists() {
  const { handle } = await H.freshDb();
  ingestListens(handle.main, [['Alpha', A], ['Bravo', B], ['Charlie', C]].map(([artist, mbid], i) =>
    withArtistMbid(H.listen({ at: 1000 + i, msid: `p${i}`, artist, title: 'Song' }), mbid)));
  matchPlays(handle.main);
  const similar = {
    [A]: [{ artist_mbid: B, name: 'Bravo', score: 9 }],
    [B]: [{ artist_mbid: C, name: 'Charlie', score: 8 }, { artist_mbid: X, name: 'Xenon', score: 7 }],
    [C]: [{ artist_mbid: A, name: 'Alpha', score: 6 }],
  };
  return { db: handle.main, handle, similar };
}

const edgesFrom = (db, mbid) => db.prepare(
  `SELECT d.mbid FROM edge e JOIN artist s ON s.id = e.src JOIN artist d ON d.id = e.dst WHERE s.mbid=? ORDER BY d.mbid`,
).all(mbid).map((r) => r.mbid);

test('a failed fetch keeps that artist\'s edges from the cache and is counted', async () => {
  const { db, handle, similar } = await threeArtists();
  try {
    const first = await refreshGraph(db, fakeClient({ similar }), { nowSec: 100 });
    assert.equal(first.failed, 0);
    assert.equal(first.partial, false);
    db.exec('UPDATE fetch_cache SET next_fetch_at = 0');
    const second = await refreshGraph(db, fakeClient({ similar, fail: { similar: [B] } }), { nowSec: 200 });
    assert.equal(second.failed, 1);
    assert.equal(second.partial, true);
    assert.equal(second.requests, 3);
    assert.deepEqual(edgesFrom(db, B), [C, X].sort());
    assert.deepEqual(edgesFrom(db, A), [B]);
  } finally {
    handle.close();
  }
});

test('an unknown similar artist is registered as a catalog artist and is not fetched itself', async () => {
  const { db, handle, similar } = await threeArtists();
  try {
    const client = fakeClient({ similar });
    const r = await refreshGraph(db, client, { nowSec: 100 });
    assert.equal(r.catalog_artists, 1);
    const x = db.prepare(`SELECT a.name, al.source FROM artist a JOIN artist_alias al ON al.artist_id = a.id WHERE a.mbid=?`).get(X);
    assert.deepEqual({ ...x }, { name: 'Xenon', source: 'lb:catalog' });
    db.exec('UPDATE fetch_cache SET next_fetch_at = 0');
    await refreshGraph(db, client, { nowSec: 200 });
    const asked = client.fetch.calls.filter((c) => c.path === '/similar-artists/json').map((c) => c.params.artist_mbid);
    assert.equal(asked.includes(X), false);
    assert.equal(asked.length, 6);
  } finally {
    handle.close();
  }
});

test('a play or a seed under a catalog artist\'s name means the played artist', async () => {
  const { db, handle, similar } = await threeArtists();
  try {
    await refreshGraph(db, fakeClient({ similar }), { nowSec: 100 });
    ingestListens(db, [H.listen({ at: 5000, msid: 'x1', artist: 'Xenon', title: 'First' }), H.listen({ at: 5001, msid: 'x2', artist: 'Xenon', title: 'Second' })]);
    matchPlays(db);
    const ids = db.prepare(`SELECT DISTINCT artist_id FROM play WHERE raw_artist='Xenon'`).all();
    assert.equal(ids.length, 1, 'both unmapped plays land on one artist');
    assert.equal(db.prepare(`SELECT count(*) AS n FROM artist WHERE name='Xenon'`).get().n, 2, 'the catalog row and the played row stay apart');
    const r = await recommend(handle, { mode: 'discover', n: 3, record: false, seeds: [{ name: 'Xenon' }], cutoffAt: 10_000 });
    assert.deepEqual(r.unresolved, [], 'a name seed resolves to the played artist, not ambiguous');
  } finally {
    handle.close();
  }
});
