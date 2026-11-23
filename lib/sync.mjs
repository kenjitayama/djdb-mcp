import { readFileSync } from 'node:fs';
import { getMeta, setMeta } from './db.mjs';
import { batch, BATCH_SIZE } from './batch.mjs';
import { listenToPlayFields, feedbackToRow } from './listenbrainz.mjs';
import { normalizeMbid } from './normalize.mjs';
import { DjdbError } from './errors.mjs';

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

/** Seconds re-fetched before the last synced listened_at on a delta sync. Duplicates are absorbed by UNIQUE(source_key). */
export const DELTA_OVERLAP_SEC = 3600;
export const META_LISTENS_MAX_TS = 'lb_listens_synced_max_ts';

export function lastSyncedListenTs(db) {
  const meta = getMeta(db, META_LISTENS_MAX_TS);
  if (meta != null && meta !== '') {
    const n = Number(meta);
    if (Number.isFinite(n)) return n;
  }
  const m = db.prepare('SELECT max(played_at) AS m FROM play').get()?.m;
  return m ?? null;
}

/**
 * Parse a ListenBrainz export (extracted JSON or JSONL). Supported shapes:
 * an array of listens; `{ listens }`; `{ payload: { listens } }` (API shape);
 * `{ payload: [listens] }`.
 */
export function parseListenBrainzExport(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return [];
    try {
      data = JSON.parse(text);
    } catch {
      const rows = [];
      for (const line of text.split(/\n/)) {
        if (!line.trim()) continue;
        rows.push(JSON.parse(line));
      }
      data = rows;
    }
  }
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.listens)) return data.listens;
  if (Array.isArray(data?.payload?.listens)) return data.payload.listens;
  if (Array.isArray(data?.payload)) return data.payload;
  throw new DjdbError('lb_export_invalid', 'could not find a list of listens in the ListenBrainz export');
}

export function loadListenBrainzExport(filePath) {
  return parseListenBrainzExport(readFileSync(filePath, 'utf8'));
}

function combineIngest(a, b) {
  return {
    inserted: (a.inserted || 0) + (b.inserted || 0),
    mapped: (a.mapped || 0) + (b.mapped || 0),
    seen: (a.seen || 0) + (b.seen || 0),
  };
}

/**
 * Listen sync policy (approved):
 * - First sync (no previous listened_at): import a ListenBrainz export file.
 * - Later syncs: GET /1/user/{user}/listens with min_ts only (deltas).
 *   min_ts is last_synced_listened_at minus DELTA_OVERLAP_SEC; UNIQUE(source_key)
 *   absorbs the overlap.
 * - Paging the whole history through /listens is only allowed when the caller
 *   sets listensFullHistory (CLI --listens-full-history), for when an export
 *   is unavailable.
 */
export async function syncListens(db, client, user, opts = {}) {
  const lastTs = lastSyncedListenTs(db);
  const exportFile = opts.exportFile;
  const fullHistory = !!(opts.listensFullHistory || opts.fullHistory);
  const overlap = opts.deltaOverlapSec ?? DELTA_OVERLAP_SEC;
  let ingested = { inserted: 0, mapped: 0, seen: 0 };
  let fetched = 0;
  let source;
  let minTs = null;

  if (lastTs == null) {
    if (exportFile) {
      const listens = loadListenBrainzExport(exportFile);
      ingested = ingestListens(db, listens, opts);
      fetched = listens.length;
      source = 'export';
    } else if (fullHistory) {
      const all = [];
      for await (const page of client.iterListens(user, { count: opts.count })) all.push(...page);
      ingested = ingestListens(db, all, opts);
      fetched = all.length;
      source = 'listens-full';
    } else {
      throw new DjdbError(
        'lb_export_required',
        'The first listen sync needs a ListenBrainz export file',
        'Pass --export <file> (the extracted ListenBrainz listens JSON). To page the whole history through GET /1/user/.../listens instead (not recommended), pass --listens-full-history.',
      );
    }
  } else {
    if (exportFile) {
      const listens = loadListenBrainzExport(exportFile);
      ingested = combineIngest(ingested, ingestListens(db, listens, opts));
      fetched += listens.length;
    }
    minTs = lastTs - overlap;
    const all = [];
    for await (const page of client.iterListens(user, { minTs, count: opts.count })) all.push(...page);
    ingested = combineIngest(ingested, ingestListens(db, all, opts));
    fetched += all.length;
    source = exportFile ? 'export+listens-delta' : 'listens-delta';
  }

  const newMax = db.prepare('SELECT max(played_at) AS m FROM play').get()?.m;
  if (newMax != null) setMeta(db, META_LISTENS_MAX_TS, String(newMax));
  return { ...ingested, fetched, source, min_ts: minTs, last_ts: newMax ?? lastTs };
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
