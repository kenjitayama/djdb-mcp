// Latency fixes on recommend(): batch song keys, bounded artist expansion, O(1) rediscover counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as H from './helpers.mjs';
import { recommend, expandToRecordings, playedBefore, songKey } from '../lib/recommend.mjs';

const DAY = 86400;
const CUTOFF = 2_000_000_000;

function mbid(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function fixture() {
  let n = 0;
  const nextMbid = () => mbid(++n);
  const key = { n: 0 };
  return { nextMbid, key };
}

function addArtist(db, { name, artistMbid = null }) {
  return Number(db.prepare(`INSERT INTO artist (name, mbid) VALUES (?,?)`).run(name, artistMbid).lastInsertRowid);
}

function addTrack(db, { title, titleNorm, artistId, trackMbid = null, position = 0, link = true }) {
  const id = Number(db.prepare(
    `INSERT INTO track (title, title_norm, norm_version, artist_credit, mbid) VALUES (?,?,?,?,?)`,
  ).run(title, titleNorm ?? title, 1, title, trackMbid).lastInsertRowid);
  if (link && artistId != null) {
    db.prepare(`INSERT INTO track_artist (track_id, position, artist_id) VALUES (?,?,?)`).run(id, position, artistId);
  }
  return id;
}

function addPlay(db, key, { at, artistId = null, trackId = null, title = 'T', quality = 'ok', match = 1 }) {
  key.n += 1;
  const source = `lb:${at}|f${key.n}`;
  db.prepare(
    `INSERT INTO play (source_key, origin, origin_version, via, via_version, played_at, ts_quality, raw_artist, raw_title, artist_id, track_id, match_version)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(source, 'test', 1, 'test', 1, at, quality, 'Artist', title, artistId, trackId, match);
}

function cacheTops(db, artistMbid, recordingMbids) {
  const body = JSON.stringify(recordingMbids.map((recording_mbid) => ({ recording_mbid })));
  db.prepare(
    `INSERT INTO fetch_cache (endpoint, key, status, body, fetched_at, next_fetch_at) VALUES ('lb:top-recordings', ?, 200, ?, 1, 9)`,
  ).run(artistMbid, body);
}

function spyStatements(db) {
  const prepare = [];
  const get = [];
  const all = [];
  const orig = db.prepare.bind(db);
  db.prepare = (sql) => {
    prepare.push(sql);
    const stmt = orig(sql);
    return {
      get: (...args) => { get.push(sql); return stmt.get(...args); },
      all: (...args) => { all.push(sql); return stmt.all(...args); },
      run: (...args) => stmt.run(...args),
    };
  };
  const count = (bucket, needle) => bucket.filter((sql) => sql.includes(needle)).length;
  return { prepare, get, all, count };
}

// The same accept rules recommend() uses, so a bounded walk can be compared to a full one.
function settled(candidates, limit, blockedTrack = () => false, blockedByMiss = () => false) {
  const sorted = candidates.slice().sort((a, b) => b.score - a.score);
  const out = [];
  const seenArtist = new Set();
  const seenTrack = new Set();
  for (const it of sorted) {
    if (blockedTrack(it.track_id)) continue;
    if (seenArtist.has(it.artist_id) || seenTrack.has(it.track_id)) continue;
    if (blockedByMiss(it.track_id)) continue;
    seenArtist.add(it.artist_id);
    seenTrack.add(it.track_id);
    out.push({
      artist_id: it.artist_id,
      track_id: it.track_id,
      score: it.score,
      pre_rank: it.pre_rank,
      source: it.source,
    });
    if (out.length >= limit) break;
  }
  return out;
}

function legacySongKey(db, trackId) {
  const r = db.prepare(
    `SELECT t.title_norm, ta.artist_id FROM track t LEFT JOIN track_artist ta ON ta.track_id = t.id AND ta.position = 0 WHERE t.id=?`,
  ).get(trackId);
  return `${r?.artist_id ?? ''}\u0000${r?.title_norm ?? ''}`;
}

function legacyPlayedBefore(db, cutoff) {
  const rows = db.prepare(
    `SELECT DISTINCT p.track_id FROM play p WHERE p.track_id IS NOT NULL AND p.match_version IS NOT NULL AND p.played_at < ?`,
  ).all(cutoff);
  const tracks = new Set(rows.map((r) => r.track_id));
  const songs = new Set([...tracks].map((id) => legacySongKey(db, id)));
  return { tracks, songs };
}

test('playedBefore matches per-track songKey, including plays the old query kept or dropped', async () => {
  const { handle } = await H.freshDb();
  const db = handle.main;
  const fx = fixture();
  try {
    const artist = addArtist(db, { name: 'Ada', artistMbid: fx.nextMbid() });
    const other = addArtist(db, { name: 'Bea', artistMbid: fx.nextMbid() });
    const played = addTrack(db, { title: 'Echo', titleNorm: 'echo', artistId: artist, trackMbid: fx.nextMbid() });
    const sameSong = addTrack(db, { title: 'Echo (Live)', titleNorm: 'echo', artistId: artist, trackMbid: fx.nextMbid() });
    const otherArtist = addTrack(db, { title: 'Echo', titleNorm: 'echo', artistId: other, trackMbid: fx.nextMbid() });
    const noCredit = addTrack(db, { title: 'Bare', titleNorm: 'bare', artistId: artist, trackMbid: fx.nextMbid(), link: false });
    const featuredOnly = addTrack(db, { title: 'Guest', titleNorm: 'guest', artistId: artist, trackMbid: fx.nextMbid(), position: 1 });
    const after = addTrack(db, { title: 'Later', titleNorm: 'later', artistId: artist, trackMbid: fx.nextMbid() });
    const unmatched = addTrack(db, { title: 'Raw', titleNorm: 'raw', artistId: artist, trackMbid: fx.nextMbid() });
    const batch = addTrack(db, { title: 'Batch', titleNorm: 'batch', artistId: artist, trackMbid: fx.nextMbid() });
    addPlay(db, fx.key, { at: CUTOFF - 10, artistId: artist, trackId: played, title: 'Echo' });
    addPlay(db, fx.key, { at: CUTOFF - 9, artistId: artist, trackId: played, title: 'Echo' });
    addPlay(db, fx.key, { at: CUTOFF, artistId: artist, trackId: after, title: 'Later' });
    addPlay(db, fx.key, { at: CUTOFF + 5, artistId: artist, trackId: after, title: 'Later' });
    addPlay(db, fx.key, { at: CUTOFF - 8, artistId: artist, trackId: unmatched, title: 'Raw', match: null });
    addPlay(db, fx.key, { at: CUTOFF - 7, artistId: artist, trackId: null, title: 'None', match: 1 });
    addPlay(db, fx.key, { at: CUTOFF - 6, artistId: artist, trackId: noCredit, title: 'Bare' });
    addPlay(db, fx.key, { at: CUTOFF - 5, artistId: artist, trackId: featuredOnly, title: 'Guest' });
    addPlay(db, fx.key, { at: CUTOFF - 4, artistId: artist, trackId: batch, title: 'Batch', quality: 'batch' });

    const got = playedBefore(db, CUTOFF);
    const old = legacyPlayedBefore(db, CUTOFF);
    assert.deepEqual([...got.tracks].sort((a, b) => a - b), [...old.tracks].sort((a, b) => a - b));
    assert.deepEqual([...got.songs].sort(), [...old.songs].sort());
    assert.equal(got.tracks.has(played), true);
    assert.equal(got.tracks.has(sameSong), false);
    assert.equal(got.songs.has(songKey(db, sameSong)), true);
    assert.equal(got.songs.has(songKey(db, otherArtist)), false);
    assert.equal(got.tracks.has(after), false);
    assert.equal(got.tracks.has(unmatched), false);
    assert.equal(got.tracks.has(batch), true, 'a batch-quality play still counts; the old query did not filter ts_quality');
    assert.equal(songKey(db, noCredit), legacySongKey(db, noCredit));
    assert.equal(songKey(db, featuredOnly), `\u0000guest`);
    assert.equal(songKey(db, featuredOnly), legacySongKey(db, featuredOnly));
    for (const id of [played, sameSong, otherArtist, noCredit, featuredOnly, after, batch]) {
      assert.equal(songKey(db, id), legacySongKey(db, id));
    }

    const seen = spyStatements(db);
    playedBefore(db, CUTOFF);
    assert.equal(seen.count(seen.all, 'SELECT DISTINCT track_id'), 1);
    assert.equal(seen.count(seen.get, 'position = 0'), 0);
  } finally {
    handle.close();
  }
});

test('bounded expansion matches a full scan when later artists outrank a weak fallback', async () => {
  const { handle } = await H.freshDb();
  const db = handle.main;
  const fx = fixture();
  try {
    const mk = (name, recordingMbids) => {
      const artistMbid = fx.nextMbid();
      const id = addArtist(db, { name, artistMbid });
      const tracks = recordingMbids.map((title) => {
        const trackMbid = fx.nextMbid();
        return { id: addTrack(db, { title, titleNorm: title, artistId: id, trackMbid }), trackMbid };
      });
      cacheTops(db, artistMbid, tracks.map((t) => t.trackMbid));
      return { id, tracks };
    };
    // A and B share A's top recording. C's only recording slots between A's hit and B's fallback.
    const a = mk('A', ['together', 'aside']);
    const b = mk('B', ['together-b', 'alone']);
    // Point B's top slot at A's recording, the case a later artist falls through.
    db.prepare(`UPDATE fetch_cache SET body=? WHERE key=(SELECT mbid FROM artist WHERE id=?)`).run(
      JSON.stringify([{ recording_mbid: a.tracks[0].trackMbid }, { recording_mbid: b.tracks[1].trackMbid }]),
      b.id,
    );
    const c = mk('C', ['center']);
    const d = mk('D', ['tail']);
    const scores = new Map([[a.id, 10], [b.id, 9], [c.id, 8], [d.id, 1]]);
    const opts = { mode: 'discover', topN: 3, cutoff: CUTOFF };
    const full = expandToRecordings(db, scores, opts);
    const seen = spyStatements(db);
    const bounded = expandToRecordings(db, scores, { ...opts, limit: 2 });
    assert.deepEqual(settled(bounded, 2), settled(full, 2));
    assert.deepEqual(settled(bounded, 2).map((r) => r.track_id), [a.tracks[0].id, c.tracks[0].id]);
    assert.equal(settled(bounded, 2)[1].pre_rank, 3);
    assert.equal(seen.count(seen.get, 'SELECT mbid FROM artist'), 3);
  } finally {
    handle.close();
  }
});

test('bounded expansion still fills the limit when higher artists have nothing usable', async () => {
  const { handle } = await H.freshDb();
  const db = handle.main;
  const fx = fixture();
  try {
    const bare = addArtist(db, { name: 'Bare' });
    const playedArtistMbid = fx.nextMbid();
    const playedArtist = addArtist(db, { name: 'Played', artistMbid: playedArtistMbid });
    const heardMbid = fx.nextMbid();
    const heardLiveMbid = fx.nextMbid();
    const heard = addTrack(db, { title: 'Heard', titleNorm: 'heard', artistId: playedArtist, trackMbid: heardMbid });
    addTrack(db, { title: 'Heard Live', titleNorm: 'heard', artistId: playedArtist, trackMbid: heardLiveMbid });
    addPlay(db, fx.key, { at: CUTOFF - 50, artistId: playedArtist, trackId: heard, title: 'Heard' });
    cacheTops(db, playedArtistMbid, [heardLiveMbid]);

    const hatedArtistMbid = fx.nextMbid();
    const hatedArtist = addArtist(db, { name: 'Hated', artistMbid: hatedArtistMbid });
    const hatedMbid = fx.nextMbid();
    const hated = addTrack(db, { title: 'Nope', titleNorm: 'nope', artistId: hatedArtist, trackMbid: hatedMbid });
    cacheTops(db, hatedArtistMbid, [hatedMbid]);

    const good = [];
    for (let i = 0; i < 2; i++) {
      const artistMbid = fx.nextMbid();
      const id = addArtist(db, { name: `Good ${i}`, artistMbid });
      const trackMbid = fx.nextMbid();
      const trackId = addTrack(db, { title: `Fresh ${i}`, titleNorm: `fresh ${i}`, artistId: id, trackMbid });
      cacheTops(db, artistMbid, [trackMbid]);
      good.push({ id, trackId });
    }
    const tailMbid = fx.nextMbid();
    const tail = addArtist(db, { name: 'Tail', artistMbid: tailMbid });
    const tailTrack = fx.nextMbid();
    addTrack(db, { title: 'Unseen', titleNorm: 'unseen', artistId: tail, trackMbid: tailTrack });
    cacheTops(db, tailMbid, [tailTrack]);

    const scores = new Map([
      [bare, 50],
      [playedArtist, 40],
      [hatedArtist, 30],
      [good[0].id, 20],
      [good[1].id, 10],
      [tail, 1],
    ]);
    const blockedTrack = (id) => id === hated;
    const opts = { mode: 'discover', topN: 3, cutoff: CUTOFF, blockedTrack };
    const full = expandToRecordings(db, scores, opts);
    const seen = spyStatements(db);
    const bounded = expandToRecordings(db, scores, { ...opts, limit: 2 });
    assert.deepEqual(settled(bounded, 2, blockedTrack), settled(full, 2, blockedTrack));
    assert.deepEqual(settled(bounded, 2, blockedTrack).map((r) => r.track_id), good.map((g) => g.trackId));
    assert.equal(seen.count(seen.get, 'SELECT mbid FROM artist'), 5);
    assert.equal(seen.count(seen.prepare, 'WHERE t.id=?'), 1);
    assert.equal(seen.count(seen.get, 'WHERE t.id=?'), 4);
  } finally {
    handle.close();
  }
});

test('tied artists past the survivor limit are not expanded', async () => {
  const { handle } = await H.freshDb();
  const db = handle.main;
  const fx = fixture();
  try {
    const artists = [];
    for (let i = 0; i < 4; i++) {
      const artistMbid = fx.nextMbid();
      const id = addArtist(db, { name: `Tie ${i}`, artistMbid });
      const trackMbid = fx.nextMbid();
      const trackId = addTrack(db, { title: `Tie ${i}`, titleNorm: `tie ${i}`, artistId: id, trackMbid });
      cacheTops(db, artistMbid, [trackMbid]);
      artists.push({ id, trackId });
    }
    const scores = new Map(artists.map((a) => [a.id, 5]));
    const opts = { mode: 'discover', topN: 3, cutoff: CUTOFF };
    const full = expandToRecordings(db, scores, opts);
    const seen = spyStatements(db);
    const bounded = expandToRecordings(db, scores, { ...opts, limit: 2 });
    assert.deepEqual(settled(bounded, 2), settled(full, 2));
    assert.deepEqual(settled(bounded, 2).map((r) => r.track_id), [artists[0].trackId, artists[1].trackId]);
    assert.equal(seen.count(seen.get, 'SELECT mbid FROM artist'), 2);
  } finally {
    handle.close();
  }
});

test('rediscover own-play fallback stops once the survivor limit is filled', async () => {
  const { handle } = await H.freshDb();
  const db = handle.main;
  const fx = fixture();
  try {
    const artists = [];
    for (let i = 0; i < 6; i++) {
      const id = addArtist(db, { name: `Old ${i}` });
      const trackId = addTrack(db, { title: `Was ${i}`, titleNorm: `was ${i}`, artistId: id, trackMbid: fx.nextMbid() });
      addPlay(db, fx.key, { at: CUTOFF - 100 - i, artistId: id, trackId, title: `Was ${i}` });
      artists.push({ id, trackId });
    }
    const scores = new Map(artists.map((a, i) => [a.id, 6 - i]));
    const opts = { mode: 'rediscover', topN: 3, cutoff: CUTOFF };
    const full = expandToRecordings(db, scores, opts);
    const seen = spyStatements(db);
    const bounded = expandToRecordings(db, scores, { ...opts, limit: 2 });
    assert.deepEqual(settled(bounded, 2), settled(full, 2));
    assert.deepEqual(settled(bounded, 2).map((r) => [r.track_id, r.source]), [
      [artists[0].trackId, 'own-plays'],
      [artists[1].trackId, 'own-plays'],
    ]);
    assert.equal(seen.count(seen.all, 'GROUP BY track_id'), 2);
  } finally {
    handle.close();
  }
});

test('discover fills 2*n without reading the rest of the artist table', async () => {
  const { handle } = await H.freshDb();
  const db = handle.main;
  const fx = fixture();
  const groups = { noMbid: 5, noCache: 5, playedSong: 5, hated: 5, miss: 4, good: 12, tail: 20 };
  const visited = groups.noMbid + groups.noCache + groups.playedSong + groups.hated + groups.miss + groups.good;
  try {
    const specs = [];
    const push = (kind, n) => { for (let i = 0; i < n; i++) specs.push(kind); };
    push('no-mbid', groups.noMbid);
    push('no-cache', groups.noCache);
    push('played-song', groups.playedSong);
    push('hated', groups.hated);
    push('miss', groups.miss);
    push('good', groups.good);
    push('tail', groups.tail);
    const goodMbids = [];
    specs.forEach((kind, i) => {
      const artistMbid = kind === 'no-mbid' ? null : fx.nextMbid();
      const artistId = addArtist(db, { name: `${kind} ${i}`, artistMbid });
      const playedMbid = fx.nextMbid();
      const played = addTrack(db, { title: `Played ${i}`, titleNorm: `played ${i}`, artistId, trackMbid: playedMbid });
      addPlay(db, fx.key, { at: CUTOFF - 1 - i, artistId, trackId: played, title: `Played ${i}` });
      if (kind === 'no-mbid' || kind === 'no-cache') return;
      let recMbid = fx.nextMbid();
      let titleNorm = `fresh ${i}`;
      if (kind === 'played-song') {
        recMbid = fx.nextMbid();
        titleNorm = `played ${i}`;
      }
      const recId = addTrack(db, { title: titleNorm, titleNorm, artistId, trackMbid: recMbid });
      cacheTops(db, artistMbid, [recMbid]);
      if (kind === 'hated') {
        db.prepare(
          `INSERT INTO lb_feedback (recording_key, recording_mbid, score, created, track_id) VALUES (?,?,?,?,?)`,
        ).run(`mbid:${recMbid}`, recMbid, -1, 1, recId);
      }
      if (kind === 'miss') {
        handle.online.prepare(
          `INSERT INTO track_resolve_miss (track_id, recording_mbid, isrc, title_norm, provider, market, tried_at, next_try_at)
           VALUES (?,?,?,?,?,?,?,?)`,
        ).run(recId, recMbid, null, titleNorm, 'spotify', 'JP', 1, CUTOFF + 10);
      }
      if (kind === 'good') goodMbids.push(recMbid);
    });

    const mainSpy = spyStatements(db);
    const onlineSpy = spyStatements(handle.online);
    const rec = await recommend(handle, { mode: 'discover', n: 6, record: false, cutoffAt: CUTOFF, provider: 'spotify', market: 'JP' });
    assert.deepEqual(rec.items.map((it) => it.recording_mbid), goodMbids);
    assert.equal(rec.items.length, 12);
    assert.equal(mainSpy.count(mainSpy.get, 'SELECT mbid FROM artist'), visited);
    assert.equal(mainSpy.count(mainSpy.get, "endpoint='lb:top-recordings'"), visited - groups.noMbid);
    assert.equal(onlineSpy.count(onlineSpy.prepare, 'FROM track_external_id'), 1);
    assert.equal(onlineSpy.count(onlineSpy.all, 'FROM track_external_id'), groups.miss + groups.good);
    assert.equal(onlineSpy.count(onlineSpy.prepare, 'FROM track_resolve_miss'), 1);
    assert.equal(onlineSpy.count(onlineSpy.all, 'FROM track_resolve_miss'), groups.miss + groups.good);
    assert.equal(mainSpy.count(mainSpy.prepare, 'WHERE t.id=?'), 1);
    assert.equal(mainSpy.count(mainSpy.all, 'SELECT DISTINCT track_id'), 1);
    assert.equal(mainSpy.count(mainSpy.get, 'WHERE t.id=?'), groups.playedSong + groups.hated + groups.miss + groups.good);
  } finally {
    handle.close();
  }
});

test('rediscover keeps artists with 0 or 1 latest-era plays and drops the rest', async () => {
  const { handle } = await H.freshDb();
  const db = handle.main;
  const fx = fixture();
  const oldBase = 1_600_000_000;
  const latestBase = oldBase + 200 * DAY;
  const cutoff = latestBase + 30 * DAY;
  try {
    const heavy = {};
    for (const name of ['Silent', 'Once', 'Twice', 'Current']) {
      const id = addArtist(db, { name, artistMbid: fx.nextMbid() });
      const trackId = addTrack(db, { title: name, titleNorm: name.toLowerCase(), artistId: id, trackMbid: fx.nextMbid() });
      heavy[name] = { id, trackId };
    }
    // Four artists at 20 plays over 5 days, plus 8 single-play fillers.
    // ceil(12 * 0.2) - 1 = 2, so the heavy cut is 20. Fillers stay under it and have one day.
    for (const { id, trackId } of Object.values(heavy)) {
      for (let day = 0; day < 5; day++) {
        for (let k = 0; k < 4; k++) {
          addPlay(db, fx.key, { at: oldBase + day * DAY + k, artistId: id, trackId, title: 'old' });
        }
      }
    }
    for (let i = 0; i < 8; i++) {
      const id = addArtist(db, { name: `Old filler ${i}` });
      const trackId = addTrack(db, { title: `Filler ${i}`, titleNorm: `filler ${i}`, artistId: id });
      addPlay(db, fx.key, { at: oldBase, artistId: id, trackId, title: 'filler' });
    }
    addPlay(db, fx.key, { at: latestBase, artistId: heavy.Once.id, trackId: heavy.Once.trackId, title: 'once' });
    for (let day = 0; day < 2; day++) {
      addPlay(db, fx.key, { at: latestBase + day * DAY, artistId: heavy.Twice.id, trackId: heavy.Twice.trackId, title: 'twice' });
    }
    for (let day = 0; day < 4; day++) {
      addPlay(db, fx.key, { at: latestBase + day * DAY, artistId: heavy.Current.id, trackId: heavy.Current.trackId, title: 'current' });
    }
    // 9 one-play artists keep the latest-era cut at 1, so only Current (4 distinct days) is latest-heavy.
    for (let i = 0; i < 9; i++) {
      const id = addArtist(db, { name: `New filler ${i}` });
      const trackId = addTrack(db, { title: `New ${i}`, titleNorm: `new ${i}`, artistId: id });
      addPlay(db, fx.key, { at: latestBase, artistId: id, trackId, title: 'new' });
    }

    const latestPlays = db.prepare(
      `SELECT artist_id FROM play WHERE played_at >= ? AND played_at < ? AND match_version IS NOT NULL`,
    ).all(latestBase, cutoff);
    const naive = (id) => latestPlays.filter((p) => p.artist_id === id).length;
    assert.equal(naive(heavy.Silent.id), 0);
    assert.equal(naive(heavy.Once.id), 1);
    assert.equal(naive(heavy.Twice.id), 2);
    assert.equal(naive(heavy.Current.id), 4);

    const rec = await recommend(handle, { mode: 'rediscover', n: 5, record: false, cutoffAt: cutoff });
    assert.deepEqual(
      rec.items.map((it) => it.artist_id).sort((a, b) => a - b),
      [heavy.Silent.id, heavy.Once.id].sort((a, b) => a - b),
    );
    assert.ok(rec.items.every((it) => it.candidate_source === 'own-plays'));
  } finally {
    handle.close();
  }
});

function eligibleArtist(db, fx, key, { name, at, titles }) {
  const artistMbid = fx.nextMbid();
  const artistId = addArtist(db, { name, artistMbid });
  const played = addTrack(db, { title: `${name} played`, titleNorm: `${name} played`, artistId, trackMbid: fx.nextMbid() });
  addPlay(db, key, { at, artistId, trackId: played, title: `${name} played` });
  const tops = titles.map((title) => {
    const trackMbid = fx.nextMbid();
    const trackId = addTrack(db, { title, titleNorm: title, artistId, trackMbid });
    return { trackId, trackMbid, title };
  });
  cacheTops(db, artistMbid, tops.map((t) => t.trackMbid));
  return { artistId, tops };
}

function impress(online, { at, artistId, trackId, titleNorm }) {
  const run = online.prepare(
    `INSERT INTO rec_run (created_at, mode, algo_version, params_hash, params_json) VALUES (?,?,?,?,?)`,
  ).run(at, 'discover', 'v11', 'hash', '{}');
  const runId = Number(run.lastInsertRowid);
  online.prepare(
    `INSERT INTO rec_item (run_id, rank, artist_id, track_id, title_norm, score) VALUES (?,?,?,?,?,?)`,
  ).run(runId, 1, artistId, trackId, titleNorm, 1);
  online.prepare(`INSERT INTO rec_event (run_id, rank, kind, at) VALUES (?,?,?,?)`).run(runId, 1, 'impression', at);
}

test('a fractional n returns floor(2*n) items', async () => {
  const { handle } = await H.freshDb();
  const db = handle.main;
  const fx = fixture();
  try {
    for (let i = 0; i < 6; i++) {
      eligibleArtist(db, fx, fx.key, { name: `N ${i}`, at: CUTOFF - 1 - i, titles: [`fresh ${i}`] });
    }
    const opts = { mode: 'discover', record: false, cutoffAt: CUTOFF };
    const two = await recommend(handle, { ...opts, n: 1.3 });
    const four = await recommend(handle, { ...opts, n: 2.25 });
    assert.equal(two.items.length, 2);
    assert.equal(four.items.length, 4);
  } finally {
    handle.close();
  }
});

test('a recent impression hides that track and the artist falls through to the next one', async () => {
  const { handle } = await H.freshDb();
  const db = handle.main;
  const fx = fixture();
  try {
    const artist = eligibleArtist(db, fx, fx.key, { name: 'Shown', at: CUTOFF - 2, titles: ['shown', 'next'] });
    impress(handle.online, { at: CUTOFF - 1, artistId: artist.artistId, trackId: artist.tops[0].trackId, titleNorm: 'shown' });
    const rec = await recommend(handle, { mode: 'discover', n: 5, record: false, cutoffAt: CUTOFF });
    assert.deepEqual(rec.items.map((it) => it.recording_mbid), [artist.tops[1].trackMbid]);
    assert.equal(rec.items[0].artist_id, artist.artistId);
  } finally {
    handle.close();
  }
});

test('eval ignores a recent impression and an active miss', async () => {
  const { handle } = await H.freshDb();
  const db = handle.main;
  const fx = fixture();
  try {
    const artist = eligibleArtist(db, fx, fx.key, { name: 'Held', at: CUTOFF - 2, titles: ['held', 'later'] });
    const top = artist.tops[0];
    impress(handle.online, { at: CUTOFF - 1, artistId: artist.artistId, trackId: top.trackId, titleNorm: 'held' });
    handle.online.prepare(
      `INSERT INTO track_resolve_miss (track_id, recording_mbid, isrc, title_norm, provider, market, tried_at, next_try_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(top.trackId, top.trackMbid, null, 'held', 'spotify', 'JP', 1, CUTOFF + 10);
    const opts = { mode: 'discover', n: 5, record: false, cutoffAt: CUTOFF, provider: 'spotify', market: 'JP' };
    const hidden = await recommend(handle, opts);
    assert.deepEqual(hidden.items.map((it) => it.recording_mbid), [artist.tops[1].trackMbid]);
    const seen = spyStatements(handle.online);
    const open = await recommend(handle, { ...opts, eval: true });
    assert.deepEqual(open.items.map((it) => it.recording_mbid), [top.trackMbid]);
    assert.equal(seen.count(seen.prepare, 'FROM track_external_id'), 0);
    assert.equal(seen.count(seen.prepare, 'FROM track_resolve_miss'), 0);
  } finally {
    handle.close();
  }
});
