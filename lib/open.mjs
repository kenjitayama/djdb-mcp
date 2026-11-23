import { existsSync } from 'node:fs';
import { assertNode } from './node-range.mjs';
import { resolvePaths, ensureDir } from './paths.mjs';
import { openWritable, openReadWriteExisting, openReadOnly, migrateOnline, isInitialized, assertSchema, userVersion, LIB_USER_VERSION } from './db.mjs';
import { bindOnline } from './online.mjs';
import { DjdbError } from './errors.mjs';

/** Open the main DB read-write (CLI commands under the lock) and, unless skipOnline, the online DB for writing. */
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
  try {
    if (isInitialized(paths.dbPath)) assertSchema(main, 'main', paths.dbPath);
    if (!opts.skipOnline) online = openOnlineForWrite(paths, main);
  } catch (e) {
    main.close();
    throw e;
  }
  return handle(paths, main, online);
}

/**
 * Open for reading. The main DB is read-only (refresh is its only writer), so a reader sees
 * committed state even while refresh holds a write transaction.
 * online: 'write' creates, migrates and binds the online DB (dj-mcp records runs and the ID cache);
 * 'read' opens an existing current-schema one read-only and never creates it (the standalone MCP server).
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
    assertSchema(main, 'main', paths.dbPath);
    if (opts.online === 'write') online = openOnlineForWrite(paths, main);
    else if (existsSync(paths.onlinePath)) {
      online = openReadOnlySafe(paths.onlinePath);
      if (userVersion(online) !== LIB_USER_VERSION.max) {
        online.close();
        online = null;
      }
    }
  } catch (e) {
    try { online?.close(); } catch {}
    main.close();
    throw e;
  }
  return handle(paths, main, online);
}

function openOnlineForWrite(paths, main) {
  ensureDir(paths.dbDir);
  const online = openWritable(paths.onlinePath);
  try {
    migrateOnline(online, paths.onlinePath);
    bindOnline(online, main);
  } catch (e) {
    online.close();
    throw e;
  }
  return online;
}

function handle(paths, main, online) {
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
