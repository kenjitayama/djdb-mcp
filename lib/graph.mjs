import { batch } from './batch.mjs';
import { cacheGet, cachePut } from './cache.mjs';
import { DEFAULT_SIMILAR_ALGORITHM } from './listenbrainz.mjs';
import { registerCatalogArtist } from './match.mjs';

const DEFAULT_TTL = 30 * 86400;

/**
 * Build artist edges from LB similar-artists. Source is 'lb:similar-artists:<algorithm>'.
 * Fetch: for every played artist with an MBID whose cache row is missing or stale, commit the
 * response to fetch_cache right away, so an interrupted stage resumes. A failed fetch keeps the
 * old cache row and counts as failed.
 * Rebuild: in one transaction, recreate every edge from the cache and register similar artists
 * that are not in the library yet (catalog artists). Catalog artists are destinations only.
 */
export async function refreshGraph(db, client, { nowSec, ttl = DEFAULT_TTL, algorithm } = {}) {
  const algo = algorithm || client.similarAlgorithm || DEFAULT_SIMILAR_ALGORITHM;
  const source = `lb:similar-artists:${algo}`;
  const at = nowSec ?? Math.floor(Date.now() / 1000);
  const played = playedArtists(db);
  let requests = 0, fetched = 0, cached = 0, failed = 0;
  for (const a of played) {
    const hit = cacheGet(db, source, a.mbid, at);
    if (hit && !hit.stale) { cached++; continue; }
    requests++;
    try {
      const body = await client.similarArtists(a.mbid, algo);
      cachePut(db, source, a.mbid, { status: 200, body, fetchedAt: at, nextFetchAt: at + ttl });
      fetched++;
    } catch {
      failed++;
    }
  }
  const rebuilt = rebuildEdges(db, source, played);
  return { source, artists: played.length, requests, fetched, cached, failed, partial: failed > 0, ...rebuilt };
}

export function playedArtists(db) {
  return db.prepare(
    `SELECT DISTINCT a.id, a.mbid FROM artist a JOIN play p ON p.artist_id = a.id WHERE a.mbid IS NOT NULL ORDER BY a.id`,
  ).all();
}

function rebuildEdges(db, source, played) {
  let edges = 0, catalogArtists = 0;
  batch(db, () => {
    db.prepare(`DELETE FROM edge WHERE source=?`).run(source);
    const ins = db.prepare(`INSERT OR IGNORE INTO edge (src, dst, source, rank, raw, fetched_at) VALUES (?,?,?,?,?,?)`);
    for (const a of played) {
      const hit = cacheGet(db, source, a.mbid, null);
      for (const item of normalizeSimilar(hit?.body)) {
        const dst = registerCatalogArtist(db, item);
        if (dst.created) catalogArtists++;
        if (dst.id === a.id) continue;
        edges += ins.run(a.id, dst.id, source, item.rank, item.score, hit.fetched_at).changes;
      }
    }
    return edges;
  });
  return { edges, catalog_artists: catalogArtists };
}

function normalizeSimilar(body) {
  if (!body) return [];
  const arr = Array.isArray(body) ? body : body.artists || body.similar_artists || body.payload || [];
  if (!Array.isArray(arr)) return [];
  return arr.map((x, i) => ({
    mbid: x.artist_mbid || x.mbid || x.id || null,
    name: x.name || x.artist_name || null,
    score: x.score ?? x.similarity ?? x.raw ?? null,
    rank: x.rank ?? i + 1,
  })).filter((x) => x.mbid);
}
