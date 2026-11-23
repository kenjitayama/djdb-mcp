import { getMeta, setMeta } from './db.mjs';
import { batch, BATCH_SIZE } from './batch.mjs';
import { listenToPlayFields, feedbackToRow } from './listenbrainz.mjs';
import { normalizeMbid } from './normalize.mjs';

/**
 * Two-step write: INSERT ON CONFLICT DO NOTHING, then a mapping-only UPDATE.
 * Commits every BATCH_SIZE rows. source_key and first-observed raw fields stay immutable.
 */
export function ingestListens(db, listens, { nowSec } = {}) {
  const ins = db.prepare(
    `INSERT INTO play (
       source_key, origin, origin_version, via, via_version, played_at, ts_quality,
       raw_artist, raw_title, raw_album, raw_duration_ms, submitted_recording_mbid,
       raw_ext_id, raw_isrc, raw_json, lb_recording_mbid, lb_mapping_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(source_key) DO NOTHING`,
  );
  const upd = db.prepare(
    `UPDATE play SET lb_recording_mbid=?, lb_mapping_at=?
     WHERE source_key=? AND (lb_recording_mbid IS NOT ? OR (lb_recording_mbid IS NULL AND ? IS NOT NULL))`,
  );
  let inserted = 0;
  let mapped = 0;
  let buf = [];
  const flush = () => {
    if (buf.length === 0) return;
    const chunk = buf;
    buf = [];
    batch(db, () => {
      let c = 0;
      for (const f of chunk) {
        const r = ins.run(
          f.source_key, f.origin, f.origin_version, f.via, f.via_version, f.played_at, f.ts_quality,
          f.raw_artist, f.raw_title, f.raw_album, f.raw_duration_ms, f.submitted_recording_mbid,
          f.raw_ext_id, f.raw_isrc, f.raw_json, null, null,
        );
        if (r.changes) { inserted += 1; c += 1; }
        if (f.lb_recording_mbid) {
          const u = upd.run(f.lb_recording_mbid, f.lb_mapping_at ?? nowSec ?? Math.floor(Date.now() / 1000), f.source_key, f.lb_recording_mbid, f.lb_recording_mbid);
          if (u.changes) { mapped += 1; c += 1; }
        }
      }
      return c;
    });
  };
  for (const listen of listens) {
    buf.push(listenToPlayFields(listen));
    if (buf.length >= BATCH_SIZE) flush();
  }
  flush();
  return { inserted, mapped, seen: listens.length };
}

/**
 * Fetch all feedback pages first; replace in one transaction only if the set changed.
 * A failed page leaves the old set untouched.
 */
export function pullFeedback(db, pages, { nowSec } = {}) {
  const rows = [];
  for (const p of pages) {
    if (p instanceof Error) return { ok: false, reason: 'fetch failed: kept old set', error: p };
    for (const f of p) {
      const row = feedbackToRow(f);
      if (row) rows.push(row);
    }
  }
  const key = (r) => `${r.recording_key}|${r.score}|${r.created}`;
  const next = rows.map(key).sort();
  const cur = db.prepare(`SELECT recording_key || '|' || score || '|' || created AS k FROM lb_feedback`).all().map((r) => r.k).sort();
  if (JSON.stringify(next) === JSON.stringify(cur)) return { ok: true, changed: 0 };
  const n = batch(db, () => {
    db.exec('DELETE FROM lb_feedback');
    const ins = db.prepare(
      `INSERT INTO lb_feedback (recording_key, recording_mbid, recording_msid, score, created, track_id) VALUES (?,?,?,?,?,?)`,
    );
    for (const r of rows) {
      const trackId = r.recording_mbid
        ? db.prepare(`SELECT id FROM track WHERE mbid=? AND merged_into IS NULL`).get(normalizeMbid(r.recording_mbid))?.id ?? null
        : null;
      ins.run(r.recording_key, r.recording_mbid, r.recording_msid, r.score, r.created, trackId);
    }
    setMeta(db, 'lb_feedback_synced_at', String(nowSec ?? Math.floor(Date.now() / 1000)));
    return 1;
  });
  return { ok: true, changed: n, count: rows.length };
}

export async function syncListensFromClient(db, client, user, opts = {}) {
  const all = [];
  for await (const page of client.iterListens(user, opts)) all.push(...page);
  return { ...ingestListens(db, all, opts), fetched: all.length };
}

export async function syncFeedbackFromClient(db, client, user, opts = {}) {
  const pages = [];
  try {
    for await (const page of client.iterFeedback(user)) pages.push(page);
  } catch (e) {
    return { ok: false, reason: 'fetch failed: kept old set', error: e };
  }
  return pullFeedback(db, pages, opts);
}

export { getMeta };
