import { batch } from './batch.mjs';
import { cacheGet, cachePut } from './cache.mjs';

const DEFAULT_TTL = 30 * 86400;
const POP_CHUNK = 100;

export async function refreshPopularity(db, client, { nowSec, ttl = DEFAULT_TTL } = {}) {
  const at = nowSec ?? Math.floor(Date.now() / 1000);
  const artists = db.prepare(`SELECT id, mbid FROM artist WHERE mbid IS NOT NULL`).all();
  let fetched = 0, cached = 0, failed = 0, paused = false;
  const popRows = [];
  for (let i = 0; i < artists.length; i += POP_CHUNK) {
    const chunk = artists.slice(i, i + POP_CHUNK);
    const need = [];
    for (const a of chunk) {
      const hit = cacheGet(db, 'lb:popularity:artist', a.mbid, at);
      if (hit && !hit.stale) {
        cached++;
        popRows.push(toPop(db, a, hit.body, at));
      } else need.push(a);
    }
    if (need.length === 0) continue;
    try {
      const body = await client.artistPopularity(need.map((a) => a.mbid));
      const by = indexByMbid(body);
      for (const a of need) {
        const row = by.get(a.mbid) ?? null;
        cachePut(db, 'lb:popularity:artist', a.mbid, { status: 200, body: row, fetchedAt: at, nextFetchAt: at + ttl });
        popRows.push(toPop(db, a, row, at));
        fetched++;
      }
    } catch (e) {
      if (e.status === 503 || e.status === 429) paused = true;
      for (const a of need) {
        const hit = cacheGet(db, 'lb:popularity:artist', a.mbid, null);
        if (hit?.body) { popRows.push(toPop(db, a, hit.body, hit.fetched_at)); cached++; }
        else failed++;
      }
    }
  }

  let topCached = 0, topFetched = 0, topFailed = 0;
  for (const a of artists) {
    const hit = cacheGet(db, 'lb:top-recordings', a.mbid, at);
    if (hit && !hit.stale) { topCached++; continue; }
    try {
      const body = await client.topRecordingsForArtist(a.mbid);
      cachePut(db, 'lb:top-recordings', a.mbid, { status: 200, body, fetchedAt: at, nextFetchAt: at + ttl });
      topFetched++;
    } catch (e) {
      if (e.status === 503 || e.status === 429) paused = true;
      if (hit?.body) topCached++;
      else topFailed++;
    }
  }

  const changed = batch(db, () => {
    const ins = db.prepare(
      `INSERT INTO artist_popularity (artist_id, source, user_count, listen_count, fetched_at) VALUES (?,?,?,?,?)
       ON CONFLICT(artist_id, source) DO UPDATE SET user_count=excluded.user_count, listen_count=excluded.listen_count, fetched_at=excluded.fetched_at`,
    );
    let c = 0;
    for (const r of popRows) {
      if (!r) continue;
      ins.run(r.artist_id, 'lb', r.user_count, r.listen_count, r.fetched_at);
      c++;
    }
    return c;
  });
  return { artists: artists.length, fetched, cached, failed, tops: { fetched: topFetched, cached: topCached, failed: topFailed }, paused, written: changed };
}

function indexByMbid(body) {
  const m = new Map();
  const arr = Array.isArray(body) ? body : [];
  for (const x of arr) {
    const id = x.artist_mbid || x.mbid;
    if (id) m.set(id, x);
  }
  return m;
}

function toPop(db, artist, row, at) {
  if (!row) return { artist_id: artist.id, user_count: null, listen_count: null, fetched_at: at };
  return {
    artist_id: artist.id,
    user_count: row.total_user_count ?? row.user_count ?? null,
    listen_count: row.total_listen_count ?? row.listen_count ?? null,
    fetched_at: at,
  };
}
