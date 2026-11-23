// The ListenBrainz client's requests and how it treats the bodies it gets back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClient, SIMILAR_ALGORITHMS } from './lb-fake.mjs';
import { DEFAULT_SIMILAR_ALGORITHM } from '../lib/listenbrainz.mjs';

const MBID = '11111111-1111-4111-8111-111111111111';

test('similar-artists is asked with artist_mbids and an algorithm the labs API accepts', async () => {
  assert.ok(SIMILAR_ALGORITHMS.includes(DEFAULT_SIMILAR_ALGORITHM), DEFAULT_SIMILAR_ALGORITHM);
  const client = fakeClient({ similar: { [MBID]: [{ artist_mbid: '22222222-2222-4222-8222-222222222222', name: 'Other', score: 5 }] } });
  const body = await client.similarArtists(MBID);
  assert.deepEqual(body.map((x) => x.name), ['Other']);
  const call = client.fetch.calls.find((c) => c.path === '/similar-artists/json');
  assert.deepEqual(call.params, { artist_mbids: MBID, algorithm: DEFAULT_SIMILAR_ALGORITHM });
});

// ---- a 200 whose body is not what the endpoint returns is refused before anything changes ----

import { freshDb, listen } from './helpers.mjs';
import { library, ARTIST_M } from './library.mjs';
import { refresh } from '../lib/refresh.mjs';
import { getMeta } from '../lib/db.mjs';
import { META_EXPORT_IMPORTED_AT } from '../lib/sync.mjs';
import { cacheGet, cachePut } from '../lib/cache.mjs';

const count = (db, table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
const later = () => Math.floor(Date.now() / 1000) + 31 * 86400;

for (const kind of ['html', 'shape']) {
  test(`listens: a 200 with ${kind === 'html' ? 'an HTML page' : 'JSON of the wrong shape'} fails lb-sync and does not complete the first import`, async () => {
    const client = fakeClient({ listens: [listen({ at: 1_700_000_000, msid: 'a1', artist: 'A', title: 'T' })], bad: { listens: kind } });
    const { handle } = await freshDb({ client });
    try {
      const r = await refresh(handle, { client, skipTokenCheck: true, listensFullHistory: true });
      assert.equal(r.ok, false);
      assert.equal(r.failed, 'lb-sync');
      assert.equal(r.results[0].code, 'lb_bad_response');
      assert.equal(count(handle.main, 'play'), 0);
      assert.equal(getMeta(handle.main, META_EXPORT_IMPORTED_AT), undefined);
    } finally {
      handle.close();
    }
  });
}

test('feedback: a 200 with an HTML page keeps the old loves and hates', async () => {
  const feedback = [{ recording_mbid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', score: 1, created: 1_700_000_000 }];
  const { handle, client } = await library({ feedback });
  try {
    assert.equal(count(handle.main, 'lb_feedback'), 1);
    client.data.bad = { feedback: 'html' };
    await refresh(handle, { client, skipTokenCheck: true });
    assert.equal(count(handle.main, 'lb_feedback'), 1);
  } finally {
    handle.close();
  }
});

test('similar-artists: a 200 with an HTML page is not cached; the last good body and its edges stay', async () => {
  const { handle, client } = await library();
  try {
    const source = `lb:similar-artists:${client.similarAlgorithm}`;
    const edges = count(handle.main, 'edge');
    assert.ok(edges > 0);
    const before = cacheGet(handle.main, source, ARTIST_M, null).body;
    client.data.bad = { similar: [ARTIST_M] };
    const r = await refresh(handle, { client, skipTokenCheck: true, nowSec: later() });
    assert.equal(r.results.find((s) => s.name === 'graph').failed, 1);
    assert.deepEqual(cacheGet(handle.main, source, ARTIST_M, null).body, before);
    assert.equal(count(handle.main, 'edge'), edges);
  } finally {
    handle.close();
  }
});

test('a cache row whose body is not JSON reads as missing instead of throwing', async () => {
  const { handle } = await freshDb();
  try {
    handle.main.prepare(`INSERT INTO fetch_cache (endpoint, key, status, body, fetched_at, next_fetch_at) VALUES ('x','k',200,'<html>',1,2)`).run();
    assert.equal(cacheGet(handle.main, 'x', 'k', 1), null);
    cachePut(handle.main, 'x', 'k2', { status: 200, body: [1], fetchedAt: 1, nextFetchAt: 2 });
    assert.deepEqual(cacheGet(handle.main, 'x', 'k2', 1).body, [1]);
  } finally {
    handle.close();
  }
});

test('feedback: a failed fetch keeps the old set and marks lb-sync partial, so the refresh is provisional', async () => {
  const { status } = await import('../lib/status.mjs');
  const feedback = [{ recording_mbid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', score: 1, created: 1_700_000_000 }];
  const { handle, client } = await library({ feedback });
  try {
    client.data.fail = { feedback: true };
    const r = await refresh(handle, { client, skipTokenCheck: true });
    assert.equal(r.ok, true);
    const sync = r.results.find((s) => s.name === 'lb-sync');
    assert.equal(sync.partial, true);
    assert.equal(sync.failed, 1);
    assert.equal(sync.feedback.ok, false);
    assert.equal(count(handle.main, 'lb_feedback'), 1);
    assert.match(getMeta(handle.main, 'refresh_note'), /stage lb-sync partial: 1 LB requests failed/);
    const st = status(handle);
    assert.equal(st.ok, true);
    assert.equal(st.provisional, true);
  } finally {
    handle.close();
  }
});

// ---- the rows inside a 2xx body are checked too (shapes measured on the live API, 2026-11-23) ----

test('similar-artists, popularity and top recordings: rows without their MBID are refused and the cache stays', async () => {
  const { handle, client } = await library();
  try {
    const db = handle.main;
    const snap = () => ({
      cache: db.prepare(`SELECT endpoint, key, body FROM fetch_cache ORDER BY endpoint, key`).all().map((r) => ({ ...r })),
      edges: count(db, 'edge'),
      pop: db.prepare(`SELECT artist_id, user_count, listen_count FROM artist_popularity ORDER BY artist_id`).all().map((r) => ({ ...r })),
    });
    const before = snap();
    client.data.bad = { similar: { body: [{}] }, popularity: { body: [{}] }, tops: { body: [{ recording_name: 'x' }] } };
    const r = await refresh(handle, { client, skipTokenCheck: true, nowSec: later() });
    const stage = (n) => r.results.find((s) => s.name === n);
    assert.ok(stage('graph').failed > 0);
    assert.ok(stage('popularity').popularity.failed > 0);
    assert.ok(stage('popularity').tops.failed > 0);
    const after = snap();
    assert.deepEqual(after.cache.map((c) => [c.endpoint, c.key, c.body]), before.cache.map((c) => [c.endpoint, c.key, c.body]));
    assert.equal(after.edges, before.edges);
    assert.deepEqual(after.pop, before.pop);
  } finally {
    handle.close();
  }
});

for (const [what, body] of [
  ['no total_count', { count: 0, feedback: [], offset: 0 }],
  ['an empty page before total_count', { count: 0, feedback: [], offset: 0, total_count: 1 }],
  ['a row without a score', { count: 1, feedback: [{}], offset: 0, total_count: 1 }],
]) {
  test(`feedback: a 200 with ${what} keeps the old set and marks lb-sync partial`, async () => {
    const feedback = [{ recording_mbid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', score: 1, created: 1_700_000_000 }];
    const { handle, client } = await library({ feedback });
    try {
      client.data.bad = { feedback: { body } };
      const r = await refresh(handle, { client, skipTokenCheck: true });
      assert.equal(r.results.find((s) => s.name === 'lb-sync').partial, true);
      assert.equal(r.results.find((s) => s.name === 'lb-sync').feedback.code, 'lb_bad_response');
      assert.equal(count(handle.main, 'lb_feedback'), 1);
    } finally {
      handle.close();
    }
  });
}

test('listens: a listen without track_metadata fails lb-sync and imports nothing', async () => {
  const client = fakeClient({ bad: { listens: { body: { payload: { count: 1, listens: [{ listened_at: 1_700_000_000, recording_msid: 'x' }] } } } } });
  const { handle } = await freshDb({ client });
  try {
    const r = await refresh(handle, { client, skipTokenCheck: true, listensFullHistory: true });
    assert.equal(r.results[0].code, 'lb_bad_response');
    assert.equal(count(handle.main, 'play'), 0);
  } finally {
    handle.close();
  }
});

const FB = [
  { recording_mbid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', score: 1, created: 1_700_000_000 },
  { recording_mbid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', score: -1, created: 1_700_000_100 },
];
const pagedOne = (rows, total) => (u) => {
  const offset = Number(u.searchParams.get('offset'));
  const feedback = rows.slice(offset, offset + 1);
  return { count: feedback.length, feedback, offset, total_count: total };
};

test('feedback: a short page is not the end; pages that stop before total_count keep the old set', async () => {
  const { handle, client } = await library({ feedback: FB });
  try {
    assert.equal(count(handle.main, 'lb_feedback'), 2);
    client.data.bad = { feedback: { body: pagedOne(FB.slice(0, 1), 2) } };
    const r = await refresh(handle, { client, skipTokenCheck: true });
    assert.equal(r.results.find((s) => s.name === 'lb-sync').feedback.code, 'lb_bad_response');
    assert.equal(count(handle.main, 'lb_feedback'), 2);
  } finally {
    handle.close();
  }
});

test('feedback: a server that returns fewer rows per page than asked still syncs the whole set', async () => {
  const { handle, client } = await library();
  try {
    client.data.bad = { feedback: { body: pagedOne(FB, 2) } };
    const r = await refresh(handle, { client, skipTokenCheck: true });
    assert.equal(r.results.find((s) => s.name === 'lb-sync').partial, undefined);
    assert.equal(count(handle.main, 'lb_feedback'), 2);
  } finally {
    handle.close();
  }
});
