import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, unlinkSync, linkSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { DjdbError } from './errors.mjs';
import { openReadOnly, getMeta, setMeta, integrityOk, pageSize, LIB_USER_VERSION, userVersion, applyPragmas } from './db.mjs';
import { withLockAsync } from './lock.mjs';
import { onlineReset } from './online.mjs';
import { cleanupRestoreTemps } from './refresh.mjs';
import { refresh } from './refresh.mjs';

/**
 * djdb restore <file>:
 * lock → verify account + schema → VACUUM INTO before-restore-<time>/ (hard-link snapshots)
 * → VACUUM INTO temp → clear snapshot rows, new id_epoch, dirty=1, integrity_check
 * → check page_size vs live DB → backup() onto the live file → online-reset.
 * A crash before backup() leaves the live DB unchanged.
 */
export async function restore(handle, src, opts = {}) {
  const locked = await withLockAsync(handle.paths.lockPath, 'restore', () => runRestore(handle, src, opts), opts);
  if (locked.locked) throw new DjdbError('locked', 'another djdb command holds djdb.lock');
  return locked.result;
}

async function runRestore(handle, src, opts) {
  const { main: db, online, paths } = handle;
  cleanupRestoreTemps(paths.dbDir, paths.dbPath);
  if (!existsSync(src)) throw new DjdbError('not_found', `backup file not found: ${src}`);

  const s0 = openReadOnly(src);
  let uv, key, srcPage;
  try {
    uv = userVersion(s0);
    key = getMeta(s0, 'lb_account_key');
    srcPage = pageSize(s0);
  } finally {
    // keep s0 open for VACUUM INTO below? VACUUM INTO can run on a read-only connection.
  }
  const liveKey = getMeta(db, 'lb_account_key');
  if (uv < LIB_USER_VERSION.min || uv > LIB_USER_VERSION.max || key !== liveKey) {
    s0.close();
    throw new DjdbError('restore_refused', 'backup schema or account key does not match the live database');
  }
  const livePage = pageSize(db);
  if (srcPage !== livePage) {
    s0.close();
    throw new DjdbError('page_size_mismatch', `backup page_size is ${srcPage}, live DB is ${livePage}`);
  }

  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const aside = join(paths.dbDir, `before-restore-${now}-${randomUUID().slice(0, 8)}`);
  mkdirSync(join(aside, 'snapshots'), { recursive: true });
  const asideDb = join(aside, 'djdb.sqlite');
  db.exec(`VACUUM INTO '${asideDb.replace(/'/g, "''")}'`);
  const snapRows = db.prepare(`SELECT path FROM snapshot`).all();
  for (const r of snapRows) {
    const from = join(paths.snapsDir, r.path);
    const to = join(aside, 'snapshots', r.path);
    try { if (existsSync(from)) linkSync(from, to); } catch {}
  }

  const tmp = join(paths.dbDir, `${basename(paths.dbPath)}.restore-${randomUUID()}`);
  s0.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  s0.close();

  const t = new DatabaseSync(tmp);
  applyPragmas(t);
  t.exec('BEGIN');
  t.exec('DELETE FROM snapshot');
  t.prepare(`UPDATE meta SET value=? WHERE key='id_epoch'`).run(randomUUID());
  t.exec(`UPDATE meta SET value='1' WHERE key='dirty'`);
  t.exec('COMMIT');
  if (!integrityOk(t)) {
    t.close();
    try { unlinkSync(tmp); } catch {}
    throw new DjdbError('restore_refused', 'prepared backup failed integrity_check');
  }
  if (opts.crashBeforeApply) {
    t.close();
    return { crashed: true, temp: tmp, aside };
  }

  // In-place apply, consistent with open connections and the WAL.
  await sqliteBackup(t, paths.dbPath);
  t.close();
  try { unlinkSync(tmp); } catch {}

  // The live connection sees the restored content; refresh meta cache by continuing to use `db`.
  onlineReset(online, db);
  let published = null;
  if (opts.refreshAfter !== false && !opts.skipRefresh) {
    // Caller may run refresh separately (needs the lock we currently hold). Do not recurse into refresh here
    // because refresh takes the same lock. The CLI releases the lock and then calls refresh.
    published = 'pending';
  }
  return { ok: true, aside, id_epoch: getMeta(db, 'id_epoch'), dirty: getMeta(db, 'dirty'), published };
}
