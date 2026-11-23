import { normalizeArtist, normalizeTitle, normalizeMbid, normalizeIsrc, NORM_VERSION } from './normalize.mjs';
import { batch, BATCH_SIZE } from './batch.mjs';

function upsertArtist(db, { name, mbid }) {
  const m = normalizeMbid(mbid);
  if (m) {
    const existing = db.prepare(`SELECT id FROM artist WHERE mbid=?`).get(m);
    if (existing) {
      addAlias(db, existing.id, name, 'lb');
      return existing.id;
    }
  }
  const alias = normalizeArtist(name);
  if (alias) {
    // Catalog artists (graph destinations) are identified by MBID only, never by a play's name.
    const hits = db.prepare(`SELECT DISTINCT artist_id FROM artist_alias WHERE alias_norm=? AND source <> '${CATALOG}'`).all(alias);
    const roots = [...new Set(hits.map((h) => h.artist_id))];
    if (roots.length === 1) {
      const id = roots[0];
      const cur = db.prepare(`SELECT mbid FROM artist WHERE id=?`).get(id);
      // A different MBID under the same name is another artist: fall through and create a row.
      if (!m || !cur.mbid) {
        if (m) db.prepare(`UPDATE artist SET mbid=? WHERE id=?`).run(m, id);
        addAlias(db, id, name, 'lb');
        return id;
      }
    }
  }
  const r = db.prepare(`INSERT INTO artist (name, mbid) VALUES (?,?)`).run(name || 'Unknown', m);
  const id = Number(r.lastInsertRowid);
  addAlias(db, id, name, 'lb');
  return id;
}

/** Alias source of artists and recordings registered from LB catalog data rather than from plays. */
export const CATALOG = 'lb:catalog';

/** An artist known from LB catalog data (a similar artist). Found or created by MBID only. */
export function registerCatalogArtist(db, { mbid, name }) {
  const m = normalizeMbid(mbid);
  const existing = db.prepare(`SELECT id FROM artist WHERE mbid=?`).get(m);
  if (existing) return { id: existing.id, created: false };
  const id = Number(db.prepare(`INSERT INTO artist (name, mbid) VALUES (?,?)`).run(name || m, m).lastInsertRowid);
  addAlias(db, id, name, CATALOG);
  return { id, created: true };
}

/** A recording from an artist's LB top recordings. Found or created by MBID, credited to that artist. */
export function registerCatalogRecording(db, artistId, row) {
  const m = normalizeMbid(row.recording_mbid);
  if (!m) return { id: null, created: false };
  const existing = db.prepare(`SELECT id FROM track WHERE mbid=?`).get(m);
  if (existing) return { id: existing.id, created: false };
  const title = row.recording_name || row.title || m;
  const id = Number(db.prepare(
    `INSERT INTO track (title, title_norm, norm_version, artist_credit, mbid, duration_ms) VALUES (?,?,?,?,?,?)`,
  ).run(title, normalizeTitle(title), NORM_VERSION, row.artist_name || '', m, row.length ?? null).lastInsertRowid);
  db.prepare(`INSERT INTO track_artist (track_id, position, artist_id, join_phrase) VALUES (?,0,?,'')`).run(id, artistId);
  db.prepare(`UPDATE lb_feedback SET track_id=? WHERE recording_mbid=? AND track_id IS NULL`).run(id, m);
  return { id, created: true };
}

function addAlias(db, artistId, name, source) {
  const alias = normalizeArtist(name);
  if (!alias) return;
  db.prepare(
    `INSERT INTO artist_alias (alias_norm, artist_id, source, norm_version) VALUES (?,?,?,?)
     ON CONFLICT(alias_norm, artist_id) DO NOTHING`,
  ).run(alias, artistId, source, NORM_VERSION);
}

function upsertTrack(db, { title, artistCredit, mbid, isrc, durationMs, artistIds }) {
  const titleNorm = normalizeTitle(title);
  const recMbid = normalizeMbid(mbid);
  const recIsrc = normalizeIsrc(isrc);
  if (recMbid) {
    const existing = db.prepare(`SELECT id FROM track WHERE mbid=?`).get(recMbid);
    if (existing) {
      const id = existing.id;
      if (recIsrc) addIsrc(db, id, recIsrc);
      return id;
    }
  }
  if (recIsrc) {
    const hits = db.prepare(`SELECT track_id FROM track_isrc WHERE isrc=?`).all(recIsrc).map((r) => r.track_id);
    const unique = [...new Set(hits)];
    const named = unique.filter((id) => db.prepare(`SELECT title_norm FROM track WHERE id=?`).get(id)?.title_norm === titleNorm);
    if (named.length === 1) {
      const id = named[0];
      const cur = db.prepare(`SELECT mbid FROM track WHERE id=?`).get(id);
      // A different MBID with the same ISRC and title is another recording: fall through and create.
      if (!recMbid || !cur.mbid) {
        if (recMbid) db.prepare(`UPDATE track SET mbid=? WHERE id=?`).run(recMbid, id);
        return id;
      }
    }
  }
  // name match under the primary artist
  if (titleNorm && artistIds?.[0]) {
    const hits = db.prepare(
      `SELECT t.id FROM track t JOIN track_artist ta ON ta.track_id = t.id AND ta.position = 0
       WHERE t.title_norm=? AND ta.artist_id=? AND t.mbid IS NULL`,
    ).all(titleNorm, artistIds[0]);
    if (hits.length === 1) {
      const id = hits[0].id;
      if (recMbid) db.prepare(`UPDATE track SET mbid=? WHERE id=? AND mbid IS NULL`).run(recMbid, id);
      if (recIsrc) addIsrc(db, id, recIsrc);
      return id;
    }
  }
  const r = db.prepare(
    `INSERT INTO track (title, title_norm, norm_version, artist_credit, mbid, duration_ms) VALUES (?,?,?,?,?,?)`,
  ).run(title || 'Unknown', titleNorm, NORM_VERSION, artistCredit || '', recMbid, durationMs ?? null);
  const id = Number(r.lastInsertRowid);
  if (artistIds) {
    const ins = db.prepare(`INSERT INTO track_artist (track_id, position, artist_id, join_phrase) VALUES (?,?,?,?)`);
    artistIds.forEach((aid, i) => ins.run(id, i, aid, i === 0 ? '' : ' & '));
  }
  if (recIsrc) addIsrc(db, id, recIsrc);
  return id;
}

function addIsrc(db, trackId, isrc) {
  db.prepare(`INSERT INTO track_isrc (isrc, track_id) VALUES (?,?) ON CONFLICT(isrc, track_id) DO NOTHING`).run(isrc, trackId);
}

const MATCH_VERSION = 1;

/** Match unmatched canonical plays. Order (approved): MBID → ISRC → normalized name. */
export function matchPlays(db, { nowSec } = {}) {
  const unmatched = db.prepare(
    `SELECT id, raw_artist, raw_title, raw_album, raw_duration_ms, submitted_recording_mbid, raw_isrc, lb_recording_mbid, raw_json
     FROM play WHERE canonical_play_id IS NULL AND (track_id IS NULL OR match_version IS NULL OR match_version < ?)
     ORDER BY id`,
  ).all(MATCH_VERSION);
  let n = 0;
  const at = nowSec ?? Math.floor(Date.now() / 1000);
  const upd = db.prepare(
    `UPDATE play SET artist_id=?, track_id=?, match_method=?, match_version=?, matched_at=? WHERE id=?`,
  );
  for (let i = 0; i < unmatched.length; i += BATCH_SIZE) {
    const slice = unmatched.slice(i, i + BATCH_SIZE);
    n += batch(db, () => {
      let c = 0;
      for (const p of slice) {
        const methodMbid = p.lb_recording_mbid || p.submitted_recording_mbid;
        const artistMbid = artistMbidFromPlay(p);
        const artistId = upsertArtist(db, { name: p.raw_artist, mbid: artistMbid });
        const trackId = upsertTrack(db, {
          title: p.raw_title,
          artistCredit: p.raw_artist,
          mbid: methodMbid,
          isrc: p.raw_isrc,
          durationMs: p.raw_duration_ms,
          artistIds: [artistId],
        });
        const method = methodMbid ? 'mbid' : (p.raw_isrc ? 'isrc' : 'name');
        upd.run(artistId, trackId, method, MATCH_VERSION, at, p.id);
        c++;
      }
      return c;
    });
  }
  return { matched: n, version: MATCH_VERSION };
}

const DEDUP_WINDOW = 60;

/**
 * Dedup safety net: different-via rows, matching MBID or ISRC or normalized names
 * (refuse if MBID and ISRC contradict), nearest neighbour within 60s, 1-1.
 * canonical_play_id UPDATE checks "target is a root" and "do not demote a root that has children" in the same transaction.
 */
export function dedupPlays(db) {
  const roots = db.prepare(
    `SELECT id, via, played_at, raw_artist, raw_title, raw_isrc, submitted_recording_mbid, lb_recording_mbid, track_id
     FROM play WHERE canonical_play_id IS NULL ORDER BY played_at, id`,
  ).all();
  const byTime = roots;
  const used = new Set();
  const pairs = [];
  for (let i = 0; i < byTime.length; i++) {
    const a = byTime[i];
    if (used.has(a.id)) continue;
    let best = null;
    for (let j = i + 1; j < byTime.length; j++) {
      const b = byTime[j];
      if (b.played_at - a.played_at > DEDUP_WINDOW) break;
      if (used.has(b.id)) continue;
      if (a.via === b.via) continue;
      if (!sameRecordingPair(a, b)) continue;
      const dt = Math.abs(b.played_at - a.played_at);
      if (!best || dt < best.dt || (dt === best.dt && b.id < best.b.id)) best = { b, dt };
    }
    if (best) {
      used.add(a.id); used.add(best.b.id);
      // canonical = earlier, then lower id
      const [root, dup] = a.played_at < best.b.played_at || (a.played_at === best.b.played_at && a.id < best.b.id) ? [a, best.b] : [best.b, a];
      pairs.push({ rootId: root.id, dupId: dup.id });
    }
  }
  let n = 0;
  if (pairs.length) {
    n += batch(db, () => {
      let c = 0;
      for (const p of pairs) {
        const r = setCanonical(db, p.dupId, p.rootId);
        if (r === 'ok') c++;
      }
      return c;
    });
  }
  return { paired: n };
}

function sameRecordingPair(a, b) {
  const mbidA = a.lb_recording_mbid || a.submitted_recording_mbid;
  const mbidB = b.lb_recording_mbid || b.submitted_recording_mbid;
  const isrcA = normalizeIsrc(a.raw_isrc);
  const isrcB = normalizeIsrc(b.raw_isrc);
  // IDs on both sides decide; names only decide when neither ID is on both sides.
  const isrcConflict = isrcA && isrcB && isrcA !== isrcB;
  if (mbidA && mbidB) return mbidA === mbidB && !isrcConflict;
  if (isrcA && isrcB) return !isrcConflict;
  return normalizeArtist(a.raw_artist) === normalizeArtist(b.raw_artist)
    && normalizeTitle(a.raw_title) === normalizeTitle(b.raw_title);
}

export function setCanonical(db, dupId, rootId) {
  if (!db.prepare(`SELECT 1 AS x FROM play WHERE id=? AND canonical_play_id IS NULL`).get(rootId)) {
    return 'target is not a root';
  }
  if (db.prepare(`SELECT 1 AS x FROM play WHERE canonical_play_id=?`).get(dupId)) {
    return 'play has duplicates; cannot demote';
  }
  db.prepare(
    `UPDATE play SET canonical_play_id=?, artist_id=NULL, track_id=NULL, match_method=NULL, match_version=NULL, matched_at=NULL WHERE id=?`,
  ).run(rootId, dupId);
  return 'ok';
}

export { upsertArtist, upsertTrack, MATCH_VERSION, DEDUP_WINDOW };

/** Bind lb_feedback.track_id now that tracks exist.
 *  Feedback is pulled in lb-sync (before match); re-attaching via MBID at the end of match is approved.
 */
export function relinkFeedback(db) {
  const rows = db.prepare(`SELECT recording_key, recording_mbid FROM lb_feedback WHERE recording_mbid IS NOT NULL`).all();
  let n = 0;
  const upd = db.prepare(`UPDATE lb_feedback SET track_id=? WHERE recording_key=?`);
  for (const r of rows) {
    const tid = db.prepare(`SELECT id FROM track WHERE mbid=?`).get(r.recording_mbid)?.id ?? null;
    upd.run(tid, r.recording_key);
    n++;
  }
  return n;
}

function artistMbidFromPlay(p) {
  if (!p.raw_json) return null;
  try {
    const j = JSON.parse(p.raw_json);
    const info = j.track_metadata?.additional_info || {};
    const mapping = j.track_metadata?.mbid_mapping || {};
    const list = info.artist_mbids || mapping.artist_mbids || [];
    return Array.isArray(list) && list[0] ? list[0] : null;
  } catch {
    return null;
  }
}
