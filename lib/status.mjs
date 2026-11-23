import { existsSync } from 'node:fs';
import { getMeta, userVersion, isInitialized } from './db.mjs';
import { lockStatus } from './lock.mjs';
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
  out.user_version = userVersion(main);
  out.lb_user = getMeta(main, 'lb_user') ?? null;
  out.id_epoch = getMeta(main, 'id_epoch') ?? null;
  const at = getMeta(main, 'refreshed_at');
  out.refreshed_at = at ? Number(at) : null;
  out.refresh_note = getMeta(main, 'refresh_note') || '';
  if (out.refreshed_at === null) {
    out.reason = 'never refreshed: run djdb refresh';
    return out;
  }
  out.provisional = out.refresh_note !== '';
  if (out.provisional) out.provisional_note = `暫定: the last refresh stopped early (${out.refresh_note}). Earlier stages are in place. Run djdb refresh again when ListenBrainz is healthy.`;
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
  };
  out.counts = counts;
  if (!out.reason) {
    out.ok = true;
    out.reason = 'ok';
  }
  return out;
}
