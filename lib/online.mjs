import { getMeta, setMeta } from './db.mjs';
import { DjdbError } from './errors.mjs';

const DAY = 86400;
export const MISS_TTL = 30 * DAY;

/**
 * Empty every online table in place (same file, no rename) under BEGIN EXCLUSIVE, then bind it to this main DB.
 * Rec_run AUTOINCREMENT / sqlite_sequence is intentionally not cleared.
 */
export function onlineReset(online, main) {
  online.exec('BEGIN EXCLUSIVE');
  try {
    online.exec('DELETE FROM rec_event; DELETE FROM rec_item_playable; DELETE FROM rec_item; DELETE FROM rec_run; DELETE FROM track_external_id; DELETE FROM track_resolve_miss; DELETE FROM meta');
    setMeta(online, 'main_db_key', getMeta(main, 'lb_account_key'));
    online.exec('COMMIT');
    return { ok: true, message: 'reset: restart running dj-mcp processes (their writes to old run ids now fail harmlessly)' };
  } catch (e) {
    try { online.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

/** Bind a fresh online DB to this main DB. An online DB bound to another main DB is left alone. */
export function bindOnline(online, main) {
  online.exec('BEGIN IMMEDIATE');
  try {
    if (!getMeta(online, 'main_db_key')) setMeta(online, 'main_db_key', getMeta(main, 'lb_account_key'));
    online.exec('COMMIT');
  } catch (e) {
    try { online.exec('ROLLBACK'); } catch {}
    throw e;
  }
  return bindCheck(online, main);
}

/** The main DB track's recording identity, used to check that a cache or miss row still describes it. */
export function identity(d, tid) {
  const row = d.prepare(`SELECT mbid, title_norm FROM track WHERE id=?`).get(tid);
  if (!row) return null;
  const isrcs = d.prepare(`SELECT isrc FROM track_isrc WHERE track_id=?`).all(tid).map((r) => r.isrc);
  return { mbid: row.mbid ?? null, title_norm: row.title_norm, isrcs };
}

/** A cache/miss row describes the same recording as the main DB track. */
export function sameRecording(row, id) {
  if (!row || !id) return false;
  if (row.recording_mbid != null) return row.recording_mbid === id.mbid;
  return id.isrcs.includes(row.isrc) && row.title_norm === id.title_norm;
}

export function bindCheck(online, main) {
  const mainKey = getMeta(main, 'lb_account_key');
  const onlineKey = getMeta(online, 'main_db_key');
  if (!mainKey || !onlineKey) return { ok: false, reason: 'online_db_unbound', hint: 'Open it with openReader({ online: \'write\' }) or run djdb online-reset --yes.' };
  if (mainKey !== onlineKey) {
    return {
      ok: false,
      reason: 'online_db_mismatch',
      hint: 'The online DB belongs to another main DB (for example after djdb init on a new database). Run djdb online-reset --yes, then restart dj-mcp.',
    };
  }
  return { ok: true };
}

export function recordExternalIds(online, db, runId, items, { market = 'JP', nowSec, log } = {}) {
  const at = nowSec ?? Math.floor(Date.now() / 1000);
  const notes = log || [];
  online.exec('BEGIN IMMEDIATE');
  try {
    if (!online.prepare(`SELECT 1 AS x FROM rec_run WHERE id=?`).get(runId)) {
      online.exec('ROLLBACK');
      return { error: 'unknown_run' };
    }
    for (const it of items) {
      const ri = online.prepare(`SELECT track_id, recording_mbid, isrc, title_norm FROM rec_item WHERE run_id=? AND rank=?`).get(runId, it.rank);
      if (!ri) continue;
      const tid = ri.track_id;
      if (it.status === 'ok') {
        const cur = online.prepare(`SELECT track_id FROM track_external_id WHERE provider=? AND ext_id=?`).get(it.provider, it.extId);
        if (cur && cur.track_id !== tid) {
          notes.push(`conflict ${it.provider}:${it.extId}`);
          online.prepare(
            `INSERT OR IGNORE INTO rec_item_playable (run_id, rank, provider, ext_id, play_uri, market, resolved_by, resolved_at) VALUES (?,?,?,?,?,?,'client',?)`,
          ).run(runId, it.rank, it.provider, it.extId, it.playUri ?? null, market, at);
          continue;
        }
        online.prepare(
          `INSERT INTO track_external_id (track_id, recording_mbid, isrc, title_norm, provider, ext_id, play_uri, market, method, verified_at, status)
           VALUES (?,?,?,?,?,?,?,?,?,?, 'ok')
           ON CONFLICT (provider, ext_id) DO UPDATE SET
             track_id=excluded.track_id, recording_mbid=excluded.recording_mbid, isrc=excluded.isrc,
             title_norm=excluded.title_norm, play_uri=excluded.play_uri, method=excluded.method, verified_at=excluded.verified_at, status='ok'`,
        ).run(tid, ri.recording_mbid, ri.isrc, ri.title_norm, it.provider, it.extId, it.playUri ?? null, market, it.method || 'spotify_search', at);
        online.prepare(`DELETE FROM track_resolve_miss WHERE track_id=? AND provider=? AND market=?`).run(tid, it.provider, market);
        online.prepare(
          `INSERT OR IGNORE INTO rec_item_playable (run_id, rank, provider, ext_id, play_uri, market, resolved_by, resolved_at) VALUES (?,?,?,?,?,?,'client',?)`,
        ).run(runId, it.rank, it.provider, it.extId, it.playUri ?? null, market, at);
      } else if (it.status === 'not_found') {
        if (online.prepare(`SELECT 1 AS x FROM track_external_id WHERE track_id=? AND provider=? AND status='ok'`).get(tid, it.provider)) {
          notes.push(`not_found ignored: ${tid} already has an id`);
          continue;
        }
        online.prepare(
          `INSERT INTO track_resolve_miss (track_id, recording_mbid, isrc, title_norm, provider, market, tried_at, next_try_at)
           VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT (track_id, provider, market) DO UPDATE SET
             tried_at=excluded.tried_at, next_try_at=excluded.next_try_at,
             recording_mbid=excluded.recording_mbid, isrc=excluded.isrc, title_norm=excluded.title_norm`,
        ).run(tid, ri.recording_mbid, ri.isrc, ri.title_norm, it.provider, market, at, at + MISS_TTL);
      } else {
        throw new Error('429/network errors are not recorded');
      }
    }
    online.exec('COMMIT');
    return { ok: true, log: notes };
  } catch (e) {
    try { online.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

export function recordEvent(online, runId, rank, kind, { at, provider } = {}) {
  if (runId == null) return { error: 'unknown_run' };
  online.exec('BEGIN IMMEDIATE');
  try {
    if (!online.prepare(`SELECT 1 AS x FROM rec_item WHERE run_id=? AND rank=?`).get(runId, rank)) {
      online.exec('ROLLBACK');
      return { error: 'unknown_run' };
    }
    const when = at ?? Math.floor(Date.now() / 1000);
    online.prepare(`INSERT INTO rec_event (run_id, rank, kind, at, provider) VALUES (?,?,?,?,?)`).run(runId, rank, kind, when, provider ?? null);
    online.exec('COMMIT');
    return { ok: true };
  } catch (e) {
    try { online.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

export function cachedId(online, db, tid, provider = 'spotify') {
  const id = identity(db, tid);
  if (!id) return null;
  return online.prepare(`SELECT * FROM track_external_id WHERE track_id=? AND provider=? AND status='ok'`).all(tid, provider).find((r) => sameRecording(r, id)) ?? null;
}

export function activeMiss(online, db, tid, provider, market, nowSec) {
  const id = identity(db, tid);
  if (!id) return false;
  return online.prepare(
    `SELECT * FROM track_resolve_miss WHERE track_id=? AND provider=? AND market=? AND next_try_at > ?`,
  ).all(tid, provider, market, nowSec).some((r) => sameRecording(r, id));
}

export function readHighWatermarks(online) {
  online.exec('BEGIN');
  try {
    const row = online.prepare(
      `SELECT (SELECT ifnull(max(id),0) FROM rec_run) AS prior_rec_run_max_id, (SELECT ifnull(max(id),0) FROM rec_event) AS rec_event_max_id`,
    ).get();
    online.exec('COMMIT');
    return row;
  } catch (e) {
    try { online.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

export function recentExposedTrackIds(online, hwm, { since, excludeRunMin = Infinity } = {}) {
  return online.prepare(
    `SELECT DISTINCT ri.track_id FROM rec_item ri JOIN rec_run r ON r.id = ri.run_id
     WHERE r.id <= ? AND r.id < ? AND r.created_at >= ?
       AND EXISTS (SELECT 1 FROM rec_event e WHERE e.run_id = ri.run_id AND e.rank = ri.rank AND e.kind IN ('impression','queued') AND e.id <= ?)`,
  ).all(hwm.prior_rec_run_max_id, excludeRunMin, since, hwm.rec_event_max_id).map((r) => r.track_id);
}

export function explain(online, runId) {
  if (!online) return { error: 'no_online_db' };
  const r = online.prepare(`SELECT * FROM rec_run WHERE id=?`).get(runId);
  if (!r) return { error: 'unknown_run' };
  const items = online.prepare(`SELECT * FROM rec_item WHERE run_id=? ORDER BY rank`).all(runId);
  return { status: 'ok', run: r, items };
}
