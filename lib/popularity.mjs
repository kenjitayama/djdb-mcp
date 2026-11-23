import { batch } from './batch.mjs';
import { cacheGet, cachePut } from './cache.mjs';
import { playedArtists } from './graph.mjs';
import { registerCatalogRecording } from './match.mjs';

const DEFAULT_TTL = 30 * 86400;
const POP_CHUNK = 100;
const POP = 'lb:popularity:artist';
const TOPS = 'lb:top-recordings';
/** Catalog artists fetched besides the played ones, by in-link weight. A guess; revisit with the request counts after the first import. */
export const DEFAULT_CATALOG_TOP_K = 300;
/** Top recordings per artist registered as tracks. discover picks from these after its filters. */
export const TOP_RECORDINGS_KEPT = 10;

/**
 * Artist popularity and top recordings for played artists and the top K catalog artists.
 * Fetch: commit each response to fetch_cache. A failed request keeps the old cache rows and counts as failed.
 * Rebuild: in one transaction, recreate artist_popularity from the cache and register the top recordings.
 */
export async function refreshPopularity(db, client, { nowSec, ttl = DEFAULT_TTL, catalogTopK = DEFAULT_CATALOG_TOP_K } = {}) {
  const at = nowSec ?? Math.floor(Date.now() / 1000);
  const played = playedArtists(db);
  const catalog = topCatalogArtists(db, catalogTopK);
  const targets = [...played, ...catalog];
  const requests = { popularity: 0, top_recordings: 0 };
  let paused = false;
  const pop = { fetched: 0, cached: 0, failed: 0 };
  const tops = { fetched: 0, cached: 0, failed: 0 };
  const failure = (e) => { if (e.status === 503 || e.status === 429) paused = true; };

  const fresh = (endpoint, a, count) => {
    const hit = cacheGet(db, endpoint, a.mbid, at);
    if (hit && !hit.stale) { count.cached++; return true; }
    return false;
  };
  const need = targets.filter((a) => !fresh(POP, a, pop));
  for (let i = 0; i < need.length; i += POP_CHUNK) {
    const chunk = need.slice(i, i + POP_CHUNK);
    requests.popularity++;
    try {
      const by = indexByMbid(await client.artistPopularity(chunk.map((a) => a.mbid)));
      for (const a of chunk) cachePut(db, POP, a.mbid, { status: 200, body: by.get(a.mbid) ?? null, fetchedAt: at, nextFetchAt: at + ttl });
      pop.fetched += chunk.length;
    } catch (e) {
      failure(e);
      pop.failed += chunk.length;
    }
  }
  for (const a of targets) {
    if (fresh(TOPS, a, tops)) continue;
    requests.top_recordings++;
    try {
      // LB returns every recording (over a MB for a big artist); only the kept ones are ever read.
      const body = (await client.topRecordingsForArtist(a.mbid)).slice(0, TOP_RECORDINGS_KEPT);
      cachePut(db, TOPS, a.mbid, { status: 200, body, fetchedAt: at, nextFetchAt: at + ttl });
      tops.fetched++;
    } catch (e) {
      failure(e);
      tops.failed++;
    }
  }
  const rebuilt = rebuild(db, targets);
  return {
    artists: played.length, catalog_artists: catalog.length, requests, popularity: pop, tops, paused,
    failed: pop.failed + tops.failed, partial: pop.failed + tops.failed > 0, ...rebuilt,
  };
}

/** Catalog (never played) artists ranked by in-link weight: the sum of 1/rank over edges from played artists. */
export function topCatalogArtists(db, k) {
  if (!(k > 0)) return [];
  return db.prepare(
    `SELECT a.id, a.mbid FROM edge e JOIN artist a ON a.id = e.dst
     WHERE a.mbid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM play p WHERE p.artist_id = a.id)
     GROUP BY a.id ORDER BY sum(1.0 / coalesce(e.rank, 100)) DESC, a.id LIMIT ?`,
  ).all(k);
}

function rebuild(db, targets) {
  let written = 0, recordings = 0;
  batch(db, () => {
    db.exec(`DELETE FROM artist_popularity WHERE source='lb'`);
    const ins = db.prepare(`INSERT INTO artist_popularity (artist_id, source, user_count, listen_count, fetched_at) VALUES (?,?,?,?,?)`);
    for (const a of targets) {
      const p = cacheGet(db, POP, a.mbid, null);
      if (p) {
        ins.run(a.id, 'lb', p.body?.total_user_count ?? p.body?.user_count ?? null, p.body?.total_listen_count ?? p.body?.listen_count ?? null, p.fetched_at);
        written++;
      }
      const t = cacheGet(db, TOPS, a.mbid, null);
      const rows = Array.isArray(t?.body) ? t.body : [];
      for (const row of rows.slice(0, TOP_RECORDINGS_KEPT)) if (registerCatalogRecording(db, a.id, row).created) recordings++;
    }
    return written + recordings;
  });
  return { written, recordings };
}

function indexByMbid(body) {
  const m = new Map();
  for (const x of Array.isArray(body) ? body : []) {
    const id = x.artist_mbid || x.mbid;
    if (id) m.set(id, x);
  }
  return m;
}
