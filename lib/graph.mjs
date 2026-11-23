import { batch } from './batch.mjs';
import { cacheGet, cachePut } from './cache.mjs';
import { DEFAULT_SIMILAR_ALGORITHM } from './listenbrainz.mjs';

const DEFAULT_TTL = 30 * 86400;

/**
 * Build artist edges from LB similar-artists. Source is 'lb:similar-artists:<algorithm>'.
 * Artists without an MBID are skipped (they teleport at recommend time).
 */
export async function refreshGraph(db, client, { nowSec, ttl = DEFAULT_TTL, algorithm } = {}) {
  const algo = algorithm || client.similarAlgorithm || DEFAULT_SIMILAR_ALGORITHM;
  const source = `lb:similar-artists:${algo}`;
  const at = nowSec ?? Math.floor(Date.now() / 1000);
  const artists = db.prepare(
    `SELECT id, mbid FROM artist WHERE mbid IS NOT NULL`,
  ).all();
  let fetched = 0;
  let cached = 0;
  let failed = 0;
  const rows = [];
  for (const a of artists) {
    const hit = cacheGet(db, source, a.mbid, at);
    let body = hit && !hit.stale ? hit.body : null;
    if (!body) {
      try {
        body = await client.similarArtists(a.mbid, algo);
        cachePut(db, source, a.mbid, { status: 200, body, fetchedAt: at, nextFetchAt: at + ttl });
        fetched++;
      } catch (e) {
        if (hit?.body) { body = hit.body; cached++; }
        else { failed++; continue; }
      }
    } else cached++;
    const list = normalizeSimilar(body);
    const src = a.id;
    list.forEach((item, idx) => {
      const dstId = item.mbid
        ? db.prepare(`SELECT id FROM artist WHERE mbid=?`).get(item.mbid)?.id
        : null;
      if (!dstId) return;
      const dst = dstId;
      if (dst === src) return;
      rows.push({ src, dst, source, rank: item.rank ?? idx + 1, raw: item.score ?? item.raw ?? null, fetched_at: at });
    });
  }
  const changed = batch(db, () => {
    db.prepare(`DELETE FROM edge WHERE source=?`).run(source);
    const ins = db.prepare(`INSERT INTO edge (src, dst, source, rank, raw, fetched_at) VALUES (?,?,?,?,?,?)`);
    let c = 0;
    for (const r of rows) {
      ins.run(r.src, r.dst, r.source, r.rank, r.raw, r.fetched_at);
      c++;
    }
    return c;
  });
  return { source, artists: artists.length, fetched, cached, failed, edges: changed };
}

function normalizeSimilar(body) {
  if (!body) return [];
  const arr = Array.isArray(body) ? body : body.artists || body.similar_artists || body.payload || [];
  if (!Array.isArray(arr)) return [];
  return arr.map((x, i) => ({
    mbid: x.artist_mbid || x.mbid || x.id || null,
    score: x.score ?? x.similarity ?? x.raw ?? null,
    rank: x.rank ?? i + 1,
  })).filter((x) => x.mbid);
}
