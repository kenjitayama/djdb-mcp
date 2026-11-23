import { existsSync } from 'node:fs';
import { getMeta, userVersion, LIB_USER_VERSION, isInitialized } from './db.mjs';
import { lockStatus } from './lock.mjs';
import { latestSnapshotRow, snapshotOk } from './snapshot.mjs';
import { bindCheck } from './online.mjs';
import { NODE_RANGE, nodeSupported } from './node-range.mjs';

export function status(handle, opts = {}) {
  const out = {
    ok: false,
    node: process.versions.node,
    node_supported: nodeSupported(),
    node_range: NODE_RANGE,
    db_path: handle?.paths?.dbPath ?? null,
  };
  if (!nodeSupported()) {
    out.reason = `unsupported Node ${process.versions.node} (need ${NODE_RANGE})`;
    return out;
  }
  if (!handle || !handle.paths) {
    out.reason = 'not opened';
    return out;
  }
  const { paths, main, online } = handle;
  out.db_exists = existsSync(paths.dbPath);
  if (!out.db_exists || !isInitialized(paths.dbPath)) {
    out.reason = 'no database: run djdb init';
    return out;
  }
  const lock = lockStatus(paths.lockPath);
  out.lock = lock;
  if (lock && /stale lock|unreadable lock|refresh running/.test(lock)) {
    out.reason = lock;
    // still fill the rest so status is informative
  }
  const uv = userVersion(main);
  out.user_version = uv;
  out.lb_user = getMeta(main, 'lb_user') ?? null;
  out.id_epoch = getMeta(main, 'id_epoch') ?? null;
  out.dirty = getMeta(main, 'dirty') === '1';
  out.refresh_note = getMeta(main, 'refresh_note') || '';
  if (uv < LIB_USER_VERSION.min || uv > LIB_USER_VERSION.max) {
    out.reason = 'schema changed: run djdb refresh';
    return out;
  }
  const latest = latestSnapshotRow(main);
  out.snapshot = latest ? { id: latest.id, created_at: latest.created_at, sha256: latest.sha256, pinned: latest.pinned, label: latest.label } : null;
  if (!latest) {
    out.reason = 'no snapshot: run djdb refresh';
    return out;
  }
  if (latest.user_version < LIB_USER_VERSION.min) {
    out.reason = 'schema changed: run djdb refresh';
    return out;
  }
  const snaps = main.prepare(`SELECT id, path, sha256, pinned, label FROM snapshot ORDER BY id DESC`).all();
  out.bad_pinned = snaps.filter((r) => r.pinned && !snapshotOk(paths.snapsDir, r)).map((r) => r.id);
  if (out.bad_pinned.length) out.bad_pinned_note = `pinned snapshot(s) failed verification: ${out.bad_pinned.join(', ')}`;
  out.provisional = !!(out.refresh_note && /failed/.test(out.refresh_note)) || (out.dirty && /snapshot taken after stage/.test(out.refresh_note));
  if (out.provisional) out.provisional_note = '暫定: this snapshot was taken after a refresh stage failed; run djdb refresh again when ListenBrainz is healthy.';
  if (online) {
    const bind = bindCheck(online, main);
    out.online = bind.ok ? { bound: true, id_epoch: getMeta(online, 'id_epoch') } : { bound: false, reason: bind.reason, hint: bind.hint };
    if (!bind.ok) {
      out.recommend_disabled = true;
      out.reason = out.reason || bind.reason;
      out.hint = bind.hint;
    }
  }
  const counts = {
    plays: main.prepare(`SELECT count(*) AS n FROM play`).get().n,
    plays_canonical: main.prepare(`SELECT count(*) AS n FROM play WHERE canonical_play_id IS NULL`).get().n,
    artists: main.prepare(`SELECT count(*) AS n FROM artist WHERE merged_into IS NULL`).get().n,
    tracks: main.prepare(`SELECT count(*) AS n FROM track WHERE merged_into IS NULL`).get().n,
    edges: main.prepare(`SELECT count(*) AS n FROM edge`).get().n,
    feedback: main.prepare(`SELECT count(*) AS n FROM lb_feedback`).get().n,
    snapshots: snaps.length,
  };
  out.counts = counts;
  if (!out.reason) {
    out.ok = true;
    out.reason = 'ok';
  }
  if (lock && !out.ok) {
    // lock message already set
  }
  return out;
}
