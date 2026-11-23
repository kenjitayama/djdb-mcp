// Importing an extracted ListenBrainz export: user.json plus listens/<year>/<month>.jsonl.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as H from './helpers.mjs';
import { fakeClient } from './lb-fake.mjs';
import { ingestListens, readExportDir, readJsonl, syncListens, META_EXPORT_IMPORTED_AT } from '../lib/sync.mjs';
import { getMeta } from '../lib/db.mjs';
import { runCli } from '../lib/cli.mjs';

const DAY = 86400;

function writeExport(months, user = 'tester') {
  const dir = join(H.tmpRoot('djdb-export-'), 'listenbrainz_export');
  mkdirSync(join(dir, 'listens'), { recursive: true });
  writeFileSync(join(dir, 'user.json'), JSON.stringify({ user_id: 7, username: user }));
  for (const [ym, listens] of Object.entries(months)) {
    const [y, m] = ym.split('/');
    mkdirSync(join(dir, 'listens', y), { recursive: true });
    writeFileSync(join(dir, 'listens', y, `${m}.jsonl`), listens.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
  return dir;
}

const twoMonths = () => ({
  '2024/1': Array.from({ length: 6 }, (_, i) => H.listen({ at: 1_704_067_200 + i * DAY, msid: `j${i}`, artist: 'A', title: `Jan${i}` })),
  '2024/2': Array.from({ length: 4 }, (_, i) => H.listen({ at: 1_706_745_600 + i * DAY, msid: `f${i}`, artist: 'A', title: `Feb${i}` })),
});
const plays = (db) => db.prepare('SELECT count(*) AS n FROM play').get().n;

test('a two-month export is imported in month order and marks the initial import done', async () => {
  const dir = writeExport({ '2024/10': [], ...twoMonths() });
  assert.deepEqual(readExportDir(dir, 'tester').files.map((f) => f.split('/listens/')[1]), ['2024/1.jsonl', '2024/2.jsonl', '2024/10.jsonl']);
  const { handle } = await H.freshDb();
  try {
    const client = fakeClient({});
    const r = await syncListens(handle.main, client, 'tester', { exportDir: dir, nowSec: 99 });
    assert.equal(r.inserted, 10);
    assert.equal(r.source, 'export');
    assert.equal(getMeta(handle.main, META_EXPORT_IMPORTED_AT), '99');
    assert.equal(client.fetch.calls.length, 0);
  } finally {
    handle.close();
  }
});

test('an import that stopped midway completes with the same export, without duplicates', async () => {
  const months = twoMonths();
  const dir = writeExport(months);
  const { handle } = await H.freshDb();
  try {
    ingestListens(handle.main, readJsonl(join(dir, 'listens', '2024', '1.jsonl')).slice(0, 4));
    await assert.rejects(syncListens(handle.main, fakeClient({}), 'tester', {}), { code: 'lb_export_required' });
    const r = await syncListens(handle.main, fakeClient({}), 'tester', { exportDir: dir });
    assert.equal(r.inserted, 6);
    assert.equal(plays(handle.main), 10);
    assert.ok(getMeta(handle.main, META_EXPORT_IMPORTED_AT));
  } finally {
    handle.close();
  }
});

test("another account's export is refused before anything is imported", async () => {
  const dir = writeExport(twoMonths(), 'someone_else');
  const { handle } = await H.freshDb();
  try {
    await assert.rejects(syncListens(handle.main, fakeClient({}), 'tester', { exportDir: dir }), { code: 'lb_export_user_mismatch' });
    assert.equal(plays(handle.main), 0);
  } finally {
    handle.close();
  }
});

test('a ZIP or a folder without user.json and listens/ is refused with a hint', () => {
  const root = H.tmpRoot();
  const zip = join(root, 'listenbrainz_tester_1.zip');
  writeFileSync(zip, 'PK');
  assert.throws(() => readExportDir(zip, 'tester'), (e) => e.code === 'lb_export_zip' && /unzip/.test(e.hint));
  assert.throws(() => readExportDir(root, 'tester'), { code: 'lb_export_invalid' });
  assert.throws(() => readExportDir(join(root, 'missing'), 'tester'), { code: 'lb_export_invalid' });
});

test('a fractional listened_at in the export matches the same listen from /listens', async () => {
  const at = 1_704_067_200;
  const fromApi = H.listen({ at, msid: 'same', artist: 'A', title: 'T' });
  const dir = writeExport({ '2024/1': [{ ...fromApi, listened_at: at + 0.75 }] });
  const { handle } = await H.freshDb();
  try {
    await syncListens(handle.main, fakeClient({}), 'tester', { exportDir: dir });
    const r = await syncListens(handle.main, fakeClient({ listens: [fromApi] }), 'tester', {});
    assert.equal(r.inserted, 0);
    assert.equal(plays(handle.main), 1);
  } finally {
    handle.close();
  }
});

test('djdb refresh --export <dir> imports the export', async () => {
  const dir = writeExport(twoMonths());
  const { handle, dbPath, configDir, tokenFile, client } = await H.freshDb();
  handle.close();
  const logs = [];
  const code = await runCli(['refresh', '--export', dir, '--json'], { out: (o) => logs.push(o), client, skipTokenCheck: true, dbPath, configDir, tokenFile });
  assert.equal(code, 0, JSON.stringify(logs));
  assert.equal(logs[0].results[0].listens.inserted, 10);
});

test('LISTENBRAINZ_EXPORT works like --export', async () => {
  const dir = writeExport(twoMonths());
  const { handle, dbPath, configDir, tokenFile, client } = await H.freshDb();
  handle.close();
  const logs = [];
  const saved = process.env.LISTENBRAINZ_EXPORT;
  process.env.LISTENBRAINZ_EXPORT = dir;
  try {
    const code = await runCli(['refresh', '--json'], { out: (o) => logs.push(o), client, skipTokenCheck: true, dbPath, configDir, tokenFile });
    assert.equal(code, 0, JSON.stringify(logs));
    assert.equal(logs[0].results[0].listens.inserted, 10);
  } finally {
    if (saved === undefined) delete process.env.LISTENBRAINZ_EXPORT; else process.env.LISTENBRAINZ_EXPORT = saved;
  }
});

test('a listen added to LB later with an old timestamp needs a new export; LB deletions do not reach djdb', async () => {
  const months = twoMonths();
  const { handle } = await H.freshDb();
  try {
    await syncListens(handle.main, fakeClient({}), 'tester', { exportDir: writeExport(months) });
    const backdated = H.listen({ at: 1_704_067_200 - 30 * DAY, msid: 'old1', artist: 'A', title: 'Dec' });
    const lb = [...months['2024/1'], ...months['2024/2'], backdated];
    const delta = await syncListens(handle.main, fakeClient({ listens: lb }), 'tester', {});
    assert.equal(delta.inserted, 0, 'the delta starts near the newest listen, so it never sees the back-dated one');
    const again = await syncListens(handle.main, fakeClient({ listens: lb }), 'tester', { exportDir: writeExport({ ...months, '2023/12': [backdated] }) });
    assert.equal(again.inserted, 1);
    assert.equal(plays(handle.main), 11);
    await syncListens(handle.main, fakeClient({ listens: lb.slice(1) }), 'tester', {});
    assert.equal(plays(handle.main), 11, 'a listen deleted on LB stays');
  } finally {
    handle.close();
  }
});
