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

/**
 * Open for reading. The main DB is read-only (refresh is its only writer), so a reader sees
 * committed state even while refresh holds a write transaction.
 * online: 'write' creates and migrates the online DB (dj-mcp records runs and the ID cache);
 * 'read' opens an existing one read-only and never creates it (the standalone MCP server).
 */
export function openReader(opts = {}) {
  assertNode();
  const paths = resolvePaths(opts);
  if (!isInitialized(paths.dbPath)) {
    const err = new DjdbError('no_database', `database not found: ${paths.dbPath}`, 'Run djdb init, then djdb refresh.');
    err.paths = paths;
    throw err;
  }
  const main = openReadOnlySafe(paths.dbPath);
  let online = null;
  try {
    if (opts.online === 'write') {
      online = openWritable(paths.onlinePath);
      migrateOnline(online);
      if (bindCheck(online, main).ok) epochCheck(online, main);
    } else if (existsSync(paths.onlinePath)) {
      online = openReadOnlySafe(paths.onlinePath);
      if (getMeta(online, 'id_epoch') !== getMeta(main, 'id_epoch')) {
        online.close();
        online = null;
      }
    }
  } catch (e) {
    try { online?.close(); } catch {}
    if (opts.online === 'write') {
      main.close();
      throw e;
    }
    online = null;
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
