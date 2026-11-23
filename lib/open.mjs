import { existsSync } from 'node:fs';
import { assertNode } from './node-range.mjs';
import { resolvePaths, ensureDir } from './paths.mjs';
import { openWritable, openReadWriteExisting, openReadOnly, migrateOnline, isInitialized, getMeta } from './db.mjs';
import { epochCheck, bindCheck } from './online.mjs';
import { DjdbError } from './errors.mjs';

/**
 * Open the main and online DBs.
 * Online migrations run here: BEGIN IMMEDIATE → re-read user_version → migrate → bump → COMMIT.
 * Auto-reset of the online DB uses the live main DB's id_epoch (implementation memo).
 */
export function open(opts = {}) {
  assertNode();
  const paths = resolvePaths(opts);
  const create = !!opts.create;
  if (!create && !isInitialized(paths.dbPath) && !opts.allowMissing) {
    const err = new DjdbError('no_database', `database not found: ${paths.dbPath}`, 'Run djdb init.');
    err.paths = paths;
    throw err;
  }
  if (create) ensureDir(paths.dbDir);
  const main = create && !existsSync(paths.dbPath) ? openWritable(paths.dbPath) : openReadWriteExisting(paths.dbPath);
  let online = null;
  if (!opts.skipOnline) {
    ensureDir(paths.dbDir);
    online = opts.onlineReadOnly && existsSync(paths.onlinePath)
      ? openReadOnlySafe(paths.onlinePath)
      : openWritable(paths.onlinePath);
    if (!opts.onlineReadOnly) {
      migrateOnline(online);
      if (isInitialized(paths.dbPath) && getMeta(main, 'lb_account_key') && getMeta(main, 'id_epoch')) {
        const bind = bindCheck(online, main);
        if (bind.ok) epochCheck(online, main);
      }
    }
  }
  return {
    paths,
    main,
    online,
    close() {
      try { main.close(); } catch {}
      try { online?.close(); } catch {}
    },
  };
}

function openReadOnlySafe(path) {
  const d = openReadOnly(path);
  try { d.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;'); } catch {}
  return d;
}
