import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { library } from './library.mjs';
import { openReader } from '../lib/open.mjs';
import { recommend } from '../lib/recommend.mjs';

const preview = async (dbPath, configDir) => {
  const h = openReader({ dbPath, configDir, online: 'read' });
  try {
    const r = await recommend(h, { mode: 'discover', n: 5, record: false, cutoffAt: 2_000_000_000 });
    assert.equal(h.main.isTransaction, false);
    return (r.items || []).map((i) => i.recording_mbid);
  } finally {
    h.close();
  }
};

test('a reader sees committed state while a writer holds an open transaction', async () => {
  const { handle, dbPath, configDir } = await library();
  handle.close();
  const before = await preview(dbPath, configDir);
  assert.ok(before.length > 0);
  const w = new DatabaseSync(dbPath);
  w.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE; DELETE FROM play; DELETE FROM fetch_cache; DELETE FROM edge;');
  assert.deepEqual(await preview(dbPath, configDir), before);
  w.exec('COMMIT');
  w.close();
  assert.notDeepEqual(await preview(dbPath, configDir), before, 'the deletes change the result once committed');
});

test('the reader handle refuses writes to the main DB', async () => {
  const { handle, dbPath, configDir } = await library();
  handle.close();
  const h = openReader({ dbPath, configDir, online: 'read' });
  try {
    assert.throws(() => h.main.exec('DELETE FROM play'), /readonly/i);
  } finally {
    h.close();
  }
});

test("online: 'read' never creates the online DB; recording a run needs online: 'write'", async () => {
  const { handle, dbPath, configDir, paths } = await library();
  handle.close();
  for (const f of [paths.onlinePath, paths.onlinePath + '-wal', paths.onlinePath + '-shm']) rmSync(f, { force: true });
  const r = openReader({ dbPath, configDir, online: 'read' });
  try {
    assert.equal(r.online, null);
    await assert.rejects(recommend(r, { mode: 'discover', n: 2 }), { code: 'no_online_db' });
  } finally {
    r.close();
  }
  assert.equal(existsSync(paths.onlinePath), false);
  const w = openReader({ dbPath, configDir, online: 'write' });
  try {
    assert.ok(w.online);
  } finally {
    w.close();
  }
  assert.equal(existsSync(paths.onlinePath), true);
});
