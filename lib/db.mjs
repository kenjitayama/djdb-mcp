import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { assertNode } from './node-range.mjs';
import { ensureDir } from './paths.mjs';
import { DjdbError } from './errors.mjs';

export const LIB_USER_VERSION = { min: 2, max: 2 };

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

/** Refuse a database this library cannot read. v1 (djdb 0.1) is not migrated: rebuild from the export. */
export function assertSchema(d, which, path) {
  const v = userVersion(d);
  if (v < LIB_USER_VERSION.min) {
    throw new DjdbError(
      'schema_too_old',
      `${which} DB ${path} has schema v${v}; this library needs v${LIB_USER_VERSION.min}`,
      'Move the djdb data directory aside, then run djdb init and djdb refresh --export <file> to rebuild.',
    );
  }
  if (v > LIB_USER_VERSION.max) {
    throw new DjdbError('schema_newer', `${which} DB ${path} has schema v${v}, newer than this library (v${LIB_USER_VERSION.max})`, 'Upgrade djdb-mcp.');
  }
}

/**
 * Online DB migration: BEGIN IMMEDIATE, re-read user_version, migrate, bump, COMMIT.
 * A fresh file gets the schema. Two processes cannot migrate twice: the second waits, re-reads, and sees the new version.
 */
export function migrateOnline(d, path = 'online') {
  d.exec('BEGIN IMMEDIATE');
  try {
    if (userVersion(d) === 0) d.exec(ONLINE_SCHEMA);
    assertSchema(d, 'online', path);
    d.exec('COMMIT');
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

export const schemas = { main: MAIN_SCHEMA, online: ONLINE_SCHEMA };
