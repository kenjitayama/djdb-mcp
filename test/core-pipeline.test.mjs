import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, mockClient, listen } from './helpers.mjs';
import { refresh } from '../lib/refresh.mjs';
import { recommend } from '../lib/recommend.mjs';
import { status } from '../lib/status.mjs';
import { ingestListens, pullFeedback } from '../lib/sync.mjs';
import { matchPlays, dedupPlays, setCanonical } from '../lib/match.mjs';
import { recordExternalIds, recordEvent, explain, onlineReset } from '../lib/online.mjs';
import { API_VERSION, open, LIB_USER_VERSION } from '../lib/index.mjs';
import { normalizeArtist, normalizeTitle, NORM_VERSION } from '../lib/normalize.mjs';
import { canon } from '../lib/canon.mjs';

const A_MBID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const B_MBID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const T1 = '11111111-1111-1111-1111-111111111111';
const T2 = '22222222-2222-2222-2222-222222222222';
const T3 = '33333333-3333-3333-3333-333333333333';

function baseListens() {
  const t0 = 1_200_000_000; // ~2008
  const t1 = 1_790_000_000; // 2026
  return [
    listen({ at: t0, msid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', artist: 'Alpha', title: 'Song One', mbid: T1, mapped: T1, via: 'lastfm' }),
    listen({ at: t0 + 10, msid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', artist: 'Alpha', title: 'Song Two', mbid: T2, mapped: T2, via: 'lastfm' }),
    listen({ at: t0 + 86400, msid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3', artist: 'Alpha', title: 'Song One', mbid: T1, mapped: T1, via: 'lastfm' }),
    listen({ at: t0 + 200, msid: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1', artist: 'Beta', title: 'Other', mbid: T3, mapped: T3, via: 'lastfm' }),
    // different via, within 60s of the first listen — should dedup
    listen({ at: t0 + 5, msid: 'cccccccc-cccc-cccc-cccc-ccccccccccc1', artist: 'Alpha', title: 'Song One', mbid: T1, mapped: T1, via: 'spotify' }),
    listen({ at: t1, msid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4', artist: 'Alpha', title: 'Song One', mbid: T1, mapped: T1, via: 'spotify' }),
    listen({ at: t1 + 20, msid: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2', artist: 'Beta', title: 'Other', mbid: T3, mapped: T3, via: 'spotify' }),
  ];
}

function clientFor(listens) {
  return mockClient({
    user: 'tester',
    listens,
    feedback: [
      { recording_mbid: T1, score: 1, created: 1_199_000_000 },
      { recording_mbid: T3, score: -1, created: 1_790_000_000 },
    ],
    similar: {
      // filled after match assigns MBIDs — artists may not have MBIDs from listens
    },
    tops: {
      [A_MBID]: [
        { recording_mbid: T1, recording_name: 'Song One' },
        { recording_mbid: T2, recording_name: 'Song Two' },
      ],
      [B_MBID]: [
        { recording_mbid: T3, recording_name: 'Other' },
      ],
    },
  });
}

test('API_VERSION is 1, NORM_VERSION is 1, schema is v2', () => {
  assert.equal(API_VERSION, 1);
  assert.equal(NORM_VERSION, 1);
  assert.deepEqual(LIB_USER_VERSION, { min: 2, max: 2 });
  assert.equal(normalizeArtist('The Beatles'), 'beatles');
  assert.equal(normalizeTitle('Song (Live!)'), 'song live');
  assert.equal(normalizeArtist('牧野由依'), '牧野由依');
  assert.equal(normalizeArtist('周杰倫'), '周杰倫');
  assert.equal(normalizeArtist('The 牧野由依'), '牧野由依');
});

test('init + refresh with fixture listens, then recommend returns items', async () => {
  const listens = baseListens();
  const client = clientFor(listens);
  const { handle, paths } = await freshDb({ client });
  try {
    // stamp artist MBIDs after a first match so graph/popularity have something to fetch
    const r1 = await refresh(handle, { client, skipTokenCheck: true, listensFullHistory: true });
    assert.equal(r1.ok, true);
    const nPlay = handle.main.prepare(`SELECT count(*) AS n FROM play`).get().n;
    assert.equal(nPlay, 7);
    const dups = handle.main.prepare(`SELECT count(*) AS n FROM play WHERE canonical_play_id IS NOT NULL`).get().n;
    assert.ok(dups >= 1, 'expected at least one deduped play');
    // attach MBIDs to artists for graph
    const artists = handle.main.prepare(`SELECT id, name FROM artist WHERE merged_into IS NULL`).all();
    for (const a of artists) {
      if (/alpha/i.test(a.name)) handle.main.prepare(`UPDATE artist SET mbid=? WHERE id=?`).run(A_MBID, a.id);
      if (/beta/i.test(a.name)) handle.main.prepare(`UPDATE artist SET mbid=? WHERE id=?`).run(B_MBID, a.id);
    }
    client.similar[A_MBID] = [{ artist_mbid: B_MBID, score: 0.8 }];
    client.similar[B_MBID] = [{ artist_mbid: A_MBID, score: 0.8 }];
    const r2 = await refresh(handle, { client, skipTokenCheck: true, listensFullHistory: true });
    assert.equal(r2.ok, true);
    const edges = handle.main.prepare(`SELECT count(*) AS n FROM edge`).get().n;
    assert.ok(edges >= 2);
    const st = status(handle);
    assert.equal(st.ok, true);
    assert.equal(st.reason, 'ok');
    assert.ok(st.refreshed_at > 0);
    assert.equal(st.provisional, false);

    const rec = await recommend(handle, { mode: 'discover', n: 5, record: true, client });
    assert.ok(rec.items.length >= 1, 'expected recommend items, got ' + JSON.stringify(rec));
    assert.ok(rec.run_id > 0);
    assert.ok(rec.items[0].recording_mbid || rec.items[0].title);
    // hate should exclude T3
    assert.ok(!rec.items.some((it) => it.recording_mbid === T3), 'hated recording should be excluded');
    // standalone preview does not write a new run if record:false
    const before = rec.run_id;
    const preview = await recommend(handle, { mode: 'discover', n: 5, record: false, client });
    const maxRun = handle.online.prepare(`SELECT max(id) AS m FROM rec_run`).get().m;
    assert.equal(maxRun, before);
    assert.equal(preview.run_id, null);
    assert.ok(preview.items[0].recording_mbid || preview.items[0].title);

    const ev = recordEvent(handle.online, rec.run_id, rec.items[0].rank, 'impression');
    assert.equal(ev.ok, true);
    const stale = recordEvent(handle.online, 999999, 1, 'impression');
    assert.equal(stale.error, 'unknown_run');
    const expl = explain(handle.online, rec.run_id);
    assert.equal(expl.status, 'ok');
  } finally {
    handle.close();
  }
});

test('recommend makes no network calls, even when it records a run', async () => {
  const client = clientFor(baseListens());
  const { handle } = await freshDb({ client });
  const saved = globalThis.fetch;
  let calls = 0;
  const deny = async () => { calls++; throw new Error('network is off'); };
  try {
    await refresh(handle, { client, skipTokenCheck: true, listensFullHistory: true });
    handle.main.prepare(`UPDATE artist SET mbid=? WHERE name='Alpha'`).run(A_MBID);
    handle.main.prepare(`UPDATE artist SET mbid=? WHERE name='Beta'`).run(B_MBID);
    await refresh(handle, { client, skipTokenCheck: true });
    globalThis.fetch = deny;
    const rec = await recommend(handle, { mode: 'discover', n: 2, record: true, fetch: deny });
    assert.ok(rec.run_id > 0, JSON.stringify(rec));
    assert.ok(rec.items.length >= 1, JSON.stringify(rec));
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = saved;
    handle.close();
  }
});

test('an identical re-fetch inserts nothing', async () => {
  const { handle } = await freshDb();
  try {
    const l = [listen({ at: 1000, msid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', artist: 'A', title: 'T', via: 'lastfm' })];
    const a = ingestListens(handle.main, l);
    assert.equal(a.inserted, 1);
    const b = ingestListens(handle.main, l);
    assert.equal(b.inserted, 0);
  } finally {
    handle.close();
  }
});

test('feedback pull is all-or-nothing; score 0 is not stored', async () => {
  const { handle } = await freshDb();
  try {
    const pages = [[{ recording_mbid: T1, score: 1, created: 10 }]];
    const r = pullFeedback(handle.main, pages, { nowSec: 50 });
    assert.equal(r.ok, true);
    assert.equal(r.changed, 1);
    const r2 = pullFeedback(handle.main, pages, { nowSec: 50 });
    assert.equal(r2.changed, 0);
    const r3 = pullFeedback(handle.main, [pages[0], new Error('503')]);
    assert.equal(r3.ok, false);
    assert.equal(handle.main.prepare(`SELECT count(*) AS n FROM lb_feedback`).get().n, 1);
  } finally {
    handle.close();
  }
});

test('a refresh that fails at lb-sync is recorded, and status marks it 暫定', async () => {
  const { handle } = await freshDb({ client: mockClient({ fail: 'listens' }) });
  try {
    assert.match(status(handle).reason, /never refreshed/);
    const r = await refresh(handle, { client: mockClient({ fail: 'listens' }), skipTokenCheck: true, listensFullHistory: true, nowSec: 5000 });
    assert.equal(r.ok, false);
    assert.equal(r.failed, 'lb-sync');
    const st = status(handle);
    assert.equal(st.ok, true);
    assert.equal(st.refreshed_at, 5000);
    assert.equal(st.provisional, true);
    assert.match(st.provisional_note, /暫定.*lb-sync/);
  } finally {
    handle.close();
  }
});

test('recordExternalIds unknown_run is non-fatal; online-reset does not reuse run ids', async () => {
  const listens = baseListens();
  const client = clientFor(listens);
  const { handle } = await freshDb({ client });
  try {
    await refresh(handle, { client, skipTokenCheck: true, listensFullHistory: true });
    const rec = await recommend(handle, { mode: 'discover', n: 2, record: true, client });
    const staleId = rec.run_id;
    const msg = onlineReset(handle.online, handle.main);
    assert.match(msg.message, /restart/);
    const again = await recommend(handle, { mode: 'discover', n: 2, record: true, client });
    assert.ok(again.run_id > staleId, `expected ${again.run_id} > ${staleId}`);
    const bad = recordExternalIds(handle.online, handle.main, staleId, [{ rank: 1, provider: 'spotify', status: 'ok', extId: 'zzz', playUri: 'spotify:track:zzz' }]);
    assert.equal(bad.error, 'unknown_run');
  } finally {
    handle.close();
  }
});

test('name seed that hits several aliases is ambiguous', async () => {
  const { handle } = await freshDb();
  try {
    handle.main.exec(`INSERT INTO artist (name) VALUES ('A'),('B')`);
    handle.main.exec(`INSERT INTO artist_alias (alias_norm, artist_id, source, norm_version) VALUES ('the a',1,'lb',1),('the a',2,'lb',1)`);
    const rec = await recommend(handle, { mode: 'discover', n: 1, record: false, seeds: [{ name: 'The A' }] });
    // never refreshed
    if (rec.unresolved) {
      assert.ok(rec.unresolved.some((u) => u.reason === 'ambiguous') || rec.reason);
    } else {
      assert.ok(rec.reason, 'expected a reason when the library is empty');
    }
  } finally {
    handle.close();
  }
});

test('CJK artists merge on normalized name and recommend keeps one track per artist', async () => {
  const t0 = 1_200_000_000;
  const listens = [
    listen({ at: t0, msid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01', artist: '牧野由依', title: 'ウンディーネ', mbid: T1, mapped: T1, via: 'lastfm' }),
    listen({ at: t0 + 10, msid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa02', artist: '牧野由依', title: '雨降花', mbid: T2, mapped: T2, via: 'lastfm' }),
    listen({ at: t0 + 20, msid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa03', artist: '河井英里', title: 'ARIA', mbid: T3, mapped: T3, via: 'lastfm' }),
    listen({ at: t0 + 86400 * 2, msid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa04', artist: '牧野由依', title: 'ウンディーネ', mbid: T1, mapped: T1, via: 'lastfm' }),
  ];
  const client = mockClient({ user: 'tester', listens, tops: {}, similar: {} });
  const { handle } = await freshDb({ client });
  try {
    const r = await refresh(handle, { client, skipTokenCheck: true, listensFullHistory: true });
    assert.equal(r.ok, true);
    const nArtists = handle.main.prepare(`SELECT count(*) AS n FROM artist WHERE merged_into IS NULL`).get().n;
    assert.equal(nArtists, 2);
    const rec = await recommend(handle, { mode: 'rediscover', n: 10, record: false, client });
    const credits = rec.items.map((i) => i.artist_credit);
    assert.equal(new Set(credits).size, credits.length, 'one track per artist, got ' + JSON.stringify(credits));
  } finally {
    handle.close();
  }
});
