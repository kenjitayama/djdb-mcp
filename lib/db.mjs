import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { assertNode } from './node-range.mjs';
import { ensureDir } from './paths.mjs';

export const LIB_USER_VERSION = { min: 1, max: 1 };

const MAIN_SCHEMA = readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8');
const ONLINE_SCHEMA = readFileSync(new URL('../sql/schema-online.sql', import.meta.url), 'utf8');

export function applyPragmas(d) {
  d.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  return d;
}

export function openWritable(path) {
  assertNode();
  ensureDir(dirname(path));
  const d = new DatabaseSync(path);
  applyPragmas(d);
  return d;
}

export function openReadWriteExisting(path) {
  assertNode();
  if (!existsSync(path)) {
    const err = new Error(`database not found: ${path}`);
    err.code = 'no_database';
    throw err;
  }
  const d = new DatabaseSync(path);
  applyPragmas(d);
  return d;
}

export function openSnap(abs) {
  assertNode();
  const u = pathToFileURL(abs);
  u.searchParams.set('immutable', '1');
  return new DatabaseSync(u, { readOnly: true });
}

export function openReadOnly(path) {
  assertNode();
  return new DatabaseSync(path, { readOnly: true });
}

export function initMainSchema(d) {
  d.exec(MAIN_SCHEMA);
  return d;
}

export function initOnlineSchema(d) {
  d.exec(ONLINE_SCHEMA);
  return d;
}

export function userVersion(d) {
  return d.prepare('PRAGMA user_version').get().user_version;
}

export function getMeta(d, key) {
  return d.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value;
}

export function setMeta(d, key, value) {
  d.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  ).run(key, String(value));
}

export function integrityOk(d) {
  return d.prepare('PRAGMA integrity_check').get().integrity_check === 'ok';
}

export function quickCheckOk(d) {
  return d.prepare('PRAGMA quick_check').get().quick_check === 'ok';
}

export function pageSize(d) {
  return d.prepare('PRAGMA page_size').get().page_size;
}

export function isInitialized(path) {
  if (!existsSync(path)) return false;
  let d;
  try {
    d = openReadOnly(path);
    const v = userVersion(d);
    const n = d.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE name='meta'`).get().n;
    return v > 0 && n === 1;
  } catch {
    return false;
  } finally {
    try { d?.close(); } catch {}
  }
}

/**
 * Online DB migration: BEGIN IMMEDIATE, re-read user_version, migrate, bump, COMMIT.
 * Currently max=1: a fresh file gets the schema; an already-migrated file is a no-op.
 * Two processes cannot migrate twice: the second waits, re-reads, and sees the new version.
 */
export function migrateOnline(d) {
  d.exec('BEGIN IMMEDIATE');
  try {
    const v = userVersion(d);
    if (v === 0) {
      d.exec(ONLINE_SCHEMA);
    } else if (v > LIB_USER_VERSION.max) {
      d.exec('ROLLBACK');
      const err = new Error(`online DB user_version ${v} is newer than this library (${LIB_USER_VERSION.max})`);
      err.code = 'schema_newer';
      throw err;
    }
    // Future migrations (v < max) go here, then PRAGMA user_version = max.
    d.exec('COMMIT');
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

export function migrateMain(d) {
  // Main-DB migrations run only inside djdb refresh, under the lock, as a dirty batch.
  const v = userVersion(d);
  if (v === 0) {
    d.exec(MAIN_SCHEMA);
    return true;
  }
  if (v > LIB_USER_VERSION.max) {
    const err = new Error(`main DB user_version ${v} is newer than this library (${LIB_USER_VERSION.max})`);
    err.code = 'schema_newer';
    throw err;
  }
  // Future: if (v < LIB_USER_VERSION.max) { migrate; set dirty; return true; }
  return false;
}

export const schemas = { main: MAIN_SCHEMA, online: ONLINE_SCHEMA };
