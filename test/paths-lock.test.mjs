import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDbPath, resolveSnapshotPath, resolveConfigDir, tokenFilePath, pathsFromDb } from '../lib/paths.mjs';
import { withLockSync, lockStatus, unlockForce } from '../lib/lock.mjs';

test('resolveDbPath: option > env > config.json > default data dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'djdb-path-'));
  const cfg = join(root, 'cfg');
  mkdirSync(cfg);
  const savedP = process.env.DJDB_PATH;
  const savedC = process.env.DJDB_CONFIG_DIR;
  const savedX = process.env.XDG_DATA_HOME;
  try {
    delete process.env.DJDB_PATH;
    process.env.DJDB_CONFIG_DIR = cfg;
    process.env.XDG_DATA_HOME = join(root, 'data');
    assert.ok(resolveDbPath().endsWith('/djdb-mcp/djdb.sqlite'));
    writeFileSync(join(cfg, 'config.json'), JSON.stringify({ dbPath: join(root, 'custom.sqlite') }));
    assert.equal(resolveDbPath({ configDir: cfg }), join(root, 'custom.sqlite'));
    process.env.DJDB_PATH = join(root, 'env.sqlite');
    assert.equal(resolveDbPath({ configDir: cfg }), join(root, 'env.sqlite'));
    assert.equal(resolveDbPath({ dbPath: join(root, 'opt.sqlite') }), join(root, 'opt.sqlite'));
    assert.equal(tokenFilePath({ configDir: cfg }), join(cfg, 'lb-token.json'));
  } finally {
    if (savedP === undefined) delete process.env.DJDB_PATH; else process.env.DJDB_PATH = savedP;
    if (savedC === undefined) delete process.env.DJDB_CONFIG_DIR; else process.env.DJDB_CONFIG_DIR = savedC;
    if (savedX === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = savedX;
  }
});

test('snapshot path must stay under snapshots/', () => {
  const snaps = mkdtempSync(join(tmpdir(), 'djdb-snaps-'));
  assert.equal(resolveSnapshotPath(snaps, 'snap-a.db'), join(snaps, 'snap-a.db'));
  assert.throws(() => resolveSnapshotPath(snaps, '/tmp/x.db'));
  assert.throws(() => resolveSnapshotPath(snaps, '../x.db'));
});

test('lock: only the creator deletes it; stale locks are not auto-recovered', () => {
  const root = mkdtempSync(join(tmpdir(), 'djdb-lock-'));
  const lockPath = join(root, 'djdb.lock');
  const inner = [];
  const outer = withLockSync(lockPath, 'refresh', () => {
    inner.push(withLockSync(lockPath, 'refresh', () => 'x'));
    return existsSync(lockPath);
  });
  assert.equal(outer.result, true);
  assert.equal(inner[0].locked, true);
  assert.equal(existsSync(lockPath), false);

  writeFileSync(lockPath, JSON.stringify({ pid: 999999999, token: 'other', command: 'refresh', started_at: 1 }));
  const r = withLockSync(lockPath, 'refresh', () => 'ran');
  assert.equal(r.locked, true);
  assert.equal(existsSync(lockPath), true);
  assert.match(lockStatus(lockPath), /stale lock \(pid 999999999, refresh, since 1\): run djdb unlock --force/);
  let shown = '';
  assert.equal(unlockForce(lockPath, (p) => { shown = p; return false; }), 'kept');
  assert.match(shown, /pid 999999999/);
  assert.equal(unlockForce(lockPath, () => true), 'deleted');
  assert.equal(existsSync(lockPath), false);
});
