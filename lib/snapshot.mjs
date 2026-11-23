import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, existsSync, unlinkSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openSnap, integrityOk, quickCheckOk, getMeta, setMeta, userVersion } from './db.mjs';
import { resolveSnapshotPath, ensureDir } from './paths.mjs';

export function sha256File(abs) {
  return createHash('sha256').update(readFileSync(abs)).digest('hex');
}

export function snapshotOk(snapsDir, row) {
  const abs = resolveSnapshotPath(snapsDir, row.path);
  if (!existsSync(abs)) return false;
  if (sha256File(abs) !== row.sha256) return false;
  try {
    const d = openSnap(abs);
    const ok = quickCheckOk(d);
    d.close();
    return ok;
  } catch {
    return false;
  }
}

export function cleanupUnregistered(db, snapsDir) {
  ensureDir(snapsDir);
  const known = new Set(db.prepare(`SELECT path FROM snapshot`).all().map((r) => r.path));
  let n = 0;
  for (const f of readdirSync(snapsDir)) {
    if (known.has(f)) continue;
    try { unlinkSync(join(snapsDir, f)); n++; } catch {}
  }
  return n;
}

export function validateSnapshots(db, snapsDir) {
  const validIds = new Set();
  const badPinned = [];
  const rows = db.prepare(`SELECT id, path, sha256, pinned FROM snapshot ORDER BY id DESC`).all();
  for (const r of rows) {
    if (snapshotOk(snapsDir, r)) { validIds.add(r.id); continue; }
    if (r.pinned) { badPinned.push(r.id); continue; }
    db.prepare(`DELETE FROM snapshot WHERE id=?`).run(r.id);
    try { unlinkSync(resolveSnapshotPath(snapsDir, r.path)); } catch {}
  }
  return { validIds, badPinned };
}

/** Keep pinned rows and the latest `keep` snapshots (by id). */
export function cleanupSnapshots(db, snapsDir, keep = 2) {
  const drop = db.prepare(
    `SELECT id, path FROM snapshot WHERE pinned = 0 AND id NOT IN (SELECT id FROM snapshot ORDER BY id DESC LIMIT ?)`,
  ).all(keep);
  for (const r of drop) {
    db.prepare(`DELETE FROM snapshot WHERE id=?`).run(r.id);
    try { unlinkSync(resolveSnapshotPath(snapsDir, r.path)); } catch {}
  }
  return drop.map((r) => r.id);
}

/**
 * VACUUM INTO a unique path, set journal_mode=DELETE, verify, then INSERT + dirty=0 (or keepDirty) in one commit.
 */
export function publishSnapshot(db, snapsDir, { keepDirty = false, nowSec } = {}) {
  ensureDir(snapsDir);
  const rel = `snap-${randomUUID()}.db`;
  const abs = resolveSnapshotPath(snapsDir, rel);
  const quoted = abs.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${quoted}'`);
  {
    const w = new DatabaseSync(abs);
    w.exec('PRAGMA journal_mode=DELETE');
    w.close();
  }
  const sha = sha256File(abs);
  const s = openSnap(abs);
  const ok = integrityOk(s);
  const uv = userVersion(s);
  s.close();
  if (!ok || sha256File(abs) !== sha) {
    try { unlinkSync(abs); } catch {}
    throw new Error('snapshot verify failed');
  }
  const created = nowSec ?? Math.floor(Date.now() / 1000);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO snapshot (created_at, path, sha256, user_version) VALUES (?,?,?,?)`).run(created, rel, sha, uv);
    db.prepare(`UPDATE meta SET value=? WHERE key='dirty'`).run(keepDirty ? '1' : '0');
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
  return rel;
}

const verifiedInProcess = new Set();

export function resetVerifiedCache() {
  verifiedInProcess.clear();
}

/** Newest-first over retained rows until one opens and verifies (SHA once per process). */
export function openSnapshotForRead(db, snapsDir) {
  const rows = db.prepare(`SELECT id, path, sha256, pinned, label FROM snapshot ORDER BY id DESC`).all();
  for (const r of rows) {
    try {
      if (!verifiedInProcess.has(r.id) && !snapshotOk(snapsDir, r)) continue;
      verifiedInProcess.add(r.id);
      const abs = resolveSnapshotPath(snapsDir, r.path);
      return { ...r, abs, d: openSnap(abs) };
    } catch {}
  }
  return null;
}

export function latestSnapshotRow(db) {
  return db.prepare(`SELECT id, path, sha256, created_at, user_version, pinned, label FROM snapshot ORDER BY id DESC LIMIT 1`).get() ?? null;
}

export function snapshotIdEpoch(snapDb) {
  return getMeta(snapDb, 'id_epoch');
}
