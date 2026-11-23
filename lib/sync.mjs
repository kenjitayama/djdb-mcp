import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getMeta, setMeta } from './db.mjs';
import { batch, BATCH_SIZE } from './batch.mjs';
import { listenToPlayFields, feedbackToRow } from './listenbrainz.mjs';
import { normalizeMbid } from './normalize.mjs';
import { DjdbError } from './errors.mjs';

/**
 * Two-step write: INSERT ON CONFLICT DO NOTHING, then a mapping-only UPDATE.
 * Commits every BATCH_SIZE rows. source_key and first-observed raw fields stay immutable.
 * A changed LB mapping clears match_version, so the next match stage matches the play again.
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
    `UPDATE play SET lb_recording_mbid=?, lb_mapping_at=?, match_version=NULL
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
        ? db.prepare(`SELECT id FROM track WHERE mbid=?`).get(normalizeMbid(r.recording_mbid))?.id ?? null
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

/** Set when the initial history import (an export, or --listens-full-history) has completed. */
export const META_EXPORT_IMPORTED_AT = 'lb_export_imported_at';

/**
 * An extracted ListenBrainz export: user.json ({ user_id, username }) and listens/<year>/<month>.jsonl.
 * Returns the month files oldest first. A ZIP is refused: zero dependencies means no unzip.
 */
export function readExportDir(dir, expectedUser) {
  const bad = (msg) => new DjdbError('lb_export_invalid', msg, 'Pass the extracted ListenBrainz export: the folder that holds user.json and listens/.');
  if (!existsSync(dir)) throw bad(`export not found: ${dir}`);
  if (!statSync(dir).isDirectory()) {
    if (/\.zip$/i.test(dir)) throw new DjdbError('lb_export_zip', `${dir} is a ZIP`, 'Extract it first (for example unzip <file> -d <dir>), then pass --export <dir>.');
    throw bad(`${dir} is not a directory`);
  }
  const userFile = join(dir, 'user.json');
  const listensDir = join(dir, 'listens');
  if (!existsSync(userFile) || !existsSync(listensDir)) throw bad(`${dir} has no user.json or listens/`);
  const user = JSON.parse(readFileSync(userFile, 'utf8')).username;
  if (expectedUser && user !== expectedUser) {
    throw new DjdbError('lb_export_user_mismatch', `the export belongs to '${user}', but this database is bound to '${expectedUser}'`, 'Use an export of the account this database was initialized with.');
  }
  const numeric = (names, re) => names.map((n) => [n, re.exec(n)]).filter(([, m]) => m).sort((a, b) => Number(a[1][1]) - Number(b[1][1])).map(([n]) => n);
  const files = [];
  for (const year of numeric(readdirSync(listensDir), /^(\d{4})$/)) {
    for (const month of numeric(readdirSync(join(listensDir, year)), /^(\d{1,2})\.jsonl$/)) files.push(join(listensDir, year, month));
  }
  return { user, files };
}

export function readJsonl(file) {
  const rows = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) if (line.trim()) rows.push(JSON.parse(line));
  return rows;
}

/** Import every month file. Re-running after an interruption is safe: UNIQUE(source_key) absorbs what is already in. */
function importExport(db, dir, user, opts) {
  const { files } = readExportDir(dir, user);
  let total = { inserted: 0, mapped: 0, seen: 0 };
  for (const f of files) total = combineIngest(total, ingestListens(db, readJsonl(f), opts));
  setMeta(db, META_EXPORT_IMPORTED_AT, String(opts.nowSec ?? Math.floor(Date.now() / 1000)));
  return { ...total, files: files.length };
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
 * - The first sync imports a ListenBrainz export directory. Until an import has completed
 *   (META_EXPORT_IMPORTED_AT), a sync without --export fails with lb_export_required, even if
 *   some plays are already in: an import that stopped midway is finished by passing the same export again.
 * - Later syncs: GET /1/user/{user}/listens with min_ts only (deltas).
 *   min_ts is last_synced_listened_at minus DELTA_OVERLAP_SEC; UNIQUE(source_key)
 *   absorbs the overlap.
 * - Paging the whole history through /listens is only allowed when the caller
 *   sets listensFullHistory (CLI --listens-full-history), for when an export
 *   is unavailable. It also completes the initial import.
 */
export async function syncListens(db, client, user, opts = {}) {
  const exportDir = opts.exportDir;
  const fullHistory = !!opts.listensFullHistory;
  const overlap = opts.deltaOverlapSec ?? DELTA_OVERLAP_SEC;
  const warnings = [];
  const onWarn = (w) => warnings.push(w);
  const firstImport = getMeta(db, META_EXPORT_IMPORTED_AT) == null;
  let ingested = { inserted: 0, mapped: 0, seen: 0 };
  let fetched = 0;
  let source;
  let minTs = null;

  if (firstImport && !exportDir && !fullHistory) {
    throw new DjdbError(
      'lb_export_required',
      'The first listen sync needs a ListenBrainz export',
      'Pass --export <dir> (the extracted export: the folder with user.json and listens/). If an earlier import stopped midway, pass the same export again. To page the whole history through GET /1/user/.../listens instead (slow), pass --listens-full-history.',
    );
  }
  if (exportDir) {
    const r = importExport(db, exportDir, user, opts);
    ingested = combineIngest(ingested, r);
    fetched += r.seen;
    source = 'export';
  }
  if (firstImport && !exportDir) {
    const all = [];
    for await (const page of client.iterListens(user, { count: opts.count, onWarn })) all.push(...page);
    ingested = ingestListens(db, all, opts);
    fetched = all.length;
    setMeta(db, META_EXPORT_IMPORTED_AT, String(opts.nowSec ?? Math.floor(Date.now() / 1000)));
    source = 'listens-full';
  } else if (!firstImport) {
    minTs = lastSyncedListenTs(db) - overlap;
    const all = [];
    for await (const page of client.iterListens(user, { minTs, count: opts.count, onWarn })) all.push(...page);
    ingested = combineIngest(ingested, ingestListens(db, all, opts));
    fetched += all.length;
    source = exportDir ? 'export+listens-delta' : 'listens-delta';
  }

  const newMax = db.prepare('SELECT max(played_at) AS m FROM play').get()?.m;
  if (newMax != null) setMeta(db, META_LISTENS_MAX_TS, String(newMax));
  return { ...ingested, fetched, source, min_ts: minTs, last_ts: newMax ?? null, warnings };
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
