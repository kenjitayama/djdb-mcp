// The online DB binds to the main DB's lb_account_key. A mismatch disables recommend and deletes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { library } from './library.mjs';
import { openReader } from '../lib/open.mjs';
import { recommend } from '../lib/recommend.mjs';
import { status } from '../lib/status.mjs';
import { runCli } from '../lib/cli.mjs';
import { getMeta } from '../lib/db.mjs';

const opts = { mode: 'discover', n: 2, cutoffAt: 2_000_000_000 };

test("online: 'write' binds a fresh online DB to the main DB", async () => {
  const { handle, dbPath, configDir } = await library();
  try {
    assert.equal(getMeta(handle.online, 'main_db_key'), getMeta(handle.main, 'lb_account_key'));
    assert.equal(getMeta(handle.online, 'id_epoch'), undefined);
    assert.equal(getMeta(handle.main, 'id_epoch'), undefined);
  } finally {
    handle.close();
  }
  const w = openReader({ dbPath, configDir, online: 'write' });
  try {
    const rec = await recommend(w, opts);
    assert.ok(rec.run_id > 0, JSON.stringify(rec));
  } finally {
    w.close();
  }
});

test('an online DB bound to another main DB disables recommend until online-reset', async () => {
  const { handle, dbPath, configDir, paths, tokenFile, client } = await library();
  await recommend(handle, { ...opts, record: true });
  handle.close();
  const o = new DatabaseSync(paths.onlinePath);
  o.exec(`UPDATE meta SET value='another-main-db' WHERE key='main_db_key'`);
  const runs = () => o.prepare('SELECT count(*) AS n FROM rec_run').get().n;
  assert.equal(runs(), 1);

  for (const mode of ['read', 'write']) {
    const h = openReader({ dbPath, configDir, online: mode });
    try {
      const rec = await recommend(h, { ...opts, record: mode === 'write' });
      assert.equal(rec.disabled, true, mode);
      assert.equal(rec.reason, 'online_db_mismatch');
      assert.match(rec.hint, /online-reset --yes/);
      const st = status(h);
      assert.equal(st.recommend_disabled, true);
      assert.equal(st.ok, false);
    } finally {
      h.close();
    }
  }
  assert.equal(runs(), 1, 'nothing is deleted on mismatch');

  assert.equal(await runCli(['online-reset', '--yes'], { out: () => {}, dbPath, configDir, tokenFile, client }), 0);
  assert.equal(runs(), 0);
  o.close();
  const h = openReader({ dbPath, configDir, online: 'write' });
  try {
    const rec = await recommend(h, { ...opts, record: true });
    assert.ok(rec.run_id > 1, JSON.stringify(rec));
  } finally {
    h.close();
  }
});
