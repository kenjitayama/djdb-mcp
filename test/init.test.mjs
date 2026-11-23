import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as H from './helpers.mjs';
import { initDb } from '../lib/init.mjs';
import { pathsFromDb } from '../lib/paths.mjs';

const pathsIn = (root) => ({ ...pathsFromDb(join(root, 'djdb.sqlite')), configDir: root, tokenFile: join(root, 'lb-token.json') });
const opts = { token: 't', user: 'tester', skipTokenCheck: true };

test('a temporary DB left by an init that crashed before its rename does not block the next init', async () => {
  const root = H.tmpRoot();
  const paths = pathsIn(root);
  for (const f of ['djdb.sqlite.init-deadbeef', 'djdb.sqlite.init-deadbeef-wal']) writeFileSync(join(root, f), 'partial');
  const r = await initDb(paths, opts);
  assert.equal(r.lb_user, 'tester');
  assert.deepEqual(readdirSync(root).filter((f) => f.includes('.init-')), []);
  assert.equal(existsSync(paths.dbPath), true);
});

test('init refuses when the main DB or the online DB already exists', async () => {
  const root = H.tmpRoot();
  const paths = pathsIn(root);
  await initDb(paths, opts);
  await assert.rejects(initDb(paths, opts), { code: 'already_initialized' });
  const other = H.tmpRoot();
  const p2 = pathsIn(other);
  writeFileSync(p2.onlinePath, '');
  await assert.rejects(initDb(p2, opts), (e) => e.code === 'already_initialized' && /move the djdb data directory aside/.test(e.hint));
  assert.equal(existsSync(p2.dbPath), false);
});

test('init stores the token in a 0600 file that holds only the token', async () => {
  const root = H.tmpRoot();
  const paths = pathsIn(root);
  await initDb(paths, { ...opts, token: 'YOUR_LISTENBRAINZ_TOKEN' });
  assert.equal(statSync(paths.tokenFile).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(paths.tokenFile, 'utf8')), { token: 'YOUR_LISTENBRAINZ_TOKEN' });
});
