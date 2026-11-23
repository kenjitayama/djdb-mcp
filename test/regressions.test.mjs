// Must-fix regressions from review r1. Each test states the fixed behavior.
// A `todo` marks a case the current code still gets wrong; the unit that fixes it removes the mark.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import * as H from './helpers.mjs';
import { fakeClient } from './lb-fake.mjs';
import { library, withArtistMbid, ARTIST_M, ARTIST_C, REC_KNOWN, REC_UNKNOWN } from './library.mjs';
import { ingestListens, syncListens } from '../lib/sync.mjs';
import { matchPlays, dedupPlays } from '../lib/match.mjs';
import { recommend } from '../lib/recommend.mjs';
import { setMeta } from '../lib/db.mjs';
import { initDb } from '../lib/init.mjs';
import { createCore } from '../lib/mcp-core.mjs';
import { runCli } from '../lib/cli.mjs';

const mbids = (r) => (r.items || []).map((i) => i.recording_mbid);

test('#6 a name-matched artist that later gets an MBID does not break matching', { todo: 'J15' }, async () => {
  const { handle } = await H.freshDb();
  ingestListens(handle.main, [
    H.listen({ at: 1000, msid: 'a1', artist: 'Kenji Band', title: 'One' }),
    withArtistMbid(H.listen({ at: 2000, msid: 'a2', artist: 'Kenji Band', title: 'Two' }), ARTIST_M),
  ]);
  matchPlays(handle.main);
  const rows = handle.main.prepare('SELECT DISTINCT a.mbid FROM play p JOIN artist a ON a.id = p.artist_id').all();
  assert.deepEqual(rows, [{ mbid: ARTIST_M }]);
});

test('#6b a mapping that arrives after the first match re-matches the play', { todo: 'J15' }, async () => {
  const { handle } = await H.freshDb();
  ingestListens(handle.main, [H.listen({ at: 1000, msid: 'b1', artist: 'Solo', title: 'Song' })]);
  matchPlays(handle.main);
  ingestListens(handle.main, [H.listen({ at: 1000, msid: 'b1', artist: 'Solo', title: 'Song', mapped: REC_KNOWN })]);
  matchPlays(handle.main);
  const r = handle.main.prepare('SELECT p.match_method, t.mbid FROM play p JOIN track t ON t.id = p.track_id').get();
  assert.deepEqual({ ...r }, { match_method: 'mbid', mbid: REC_KNOWN });
});

test('#5 an export import that stopped midway is not silently turned into delta syncs', { todo: 'J14' }, async () => {
  const { handle } = await H.freshDb();
  const all = Array.from({ length: 10 }, (_, i) => H.listen({ at: 1_000_000 + i * 600, msid: `e${i}`, artist: 'A', title: `T${i}` }));
  ingestListens(handle.main, all.slice(5));
  const client = fakeClient({ listens: [] });
  await assert.rejects(syncListens(handle.main, client, 'tester', {}), { code: 'lb_export_required' });
  assert.equal(client.fetch.calls.length, 0);
});

test('LB-paging a delta sync with 2,500 new listens ingests all of them, paging forward with min_ts', async () => {
  const { handle } = await H.freshDb();
  ingestListens(handle.main, [H.listen({ at: 10_000, msid: 'seed', artist: 'A', title: 'T' })]);
  setMeta(handle.main, 'lb_listens_synced_max_ts', '10000');
  setMeta(handle.main, 'lb_export_imported_at', '1');
  const fresh = Array.from({ length: 2500 }, (_, i) => H.listen({ at: 20_000 + i, msid: `n${i}`, artist: 'A', title: `T${i}` }));
  const client = fakeClient({ listens: fresh });
  const r = await syncListens(handle.main, client, 'tester', {});
  assert.equal(r.inserted, 2500);
  assert.equal(r.last_ts, 22_499);
  const listenCalls = client.fetch.calls.filter((c) => c.path.endsWith('/listens'));
  assert.ok(listenCalls.length <= 4, `requests=${listenCalls.length}`);
  assert.ok(listenCalls.every((c) => c.params.max_ts == null && c.params.min_ts != null));
});

test('LB-feedback feedback paging reads every page (total_count, not the page count)', async () => {
  const fb = Array.from({ length: 1500 }, (_, i) => ({ recording_mbid: `cccccccc-cccc-4ccc-8ccc-${String(i).padStart(12, '0')}`, score: 1, created: 1000 + i }));
  const client = fakeClient({ feedback: fb });
  let n = 0;
  for await (const page of client.iterFeedback('tester')) n += page.length;
  assert.equal(n, 1500);
});

test('#10 an init that fails midway leaves no database behind and can be rerun', async () => {
  const root = H.tmpRoot();
  const blocker = join(root, 'not-a-dir');
  writeFileSync(blocker, '');
  const paths = {
    dbPath: join(root, 'djdb.sqlite'),
    dbDir: root,
    onlinePath: join(root, 'djdb-online.sqlite'),
    lockPath: join(root, 'djdb.lock'),
    configDir: root,
  };
  await assert.rejects(initDb({ ...paths, tokenFile: join(blocker, 'lb-token.json') }, { token: 't', user: 'tester', skipTokenCheck: true }));
  assert.equal(existsSync(paths.dbPath), false);
  const r = await initDb({ ...paths, tokenFile: join(root, 'lb-token.json') }, { token: 't', user: 'tester', skipTokenCheck: true });
  assert.equal(r.lb_user, 'tester');
});

test('#1 unlock refuses a lock whose pid is alive and never asks', async () => {
  const root = H.tmpRoot();
  const lockPath = join(root, 'djdb.lock');
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'x', command: 'refresh', started_at: 1 }));
  const outs = [];
  const code = await runCli(['unlock', '--db', join(root, 'djdb.sqlite')], { out: (o) => outs.push(o) });
  assert.equal(code, 1);
  assert.equal(existsSync(lockPath), true);
  assert.equal(outs.at(-1)?.error?.code, 'lock_held');
});

test('#1 unlock removes a lock whose pid is gone, without a prompt', async () => {
  const root = H.tmpRoot();
  const lockPath = join(root, 'djdb.lock');
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  writeFileSync(lockPath, JSON.stringify({ pid: dead, token: 'x', command: 'refresh', started_at: 1 }));
  const code = await runCli(['unlock', '--db', join(root, 'djdb.sqlite')], { out: () => {} });
  assert.equal(code, 0);
  assert.equal(existsSync(lockPath), false);
});

test('#2 discover returns catalog recordings the user has never played', { todo: 'J17b, J18' }, async () => {
  const { handle } = await library();
  const cutoff = 2_000_000_000;
  const r = await recommend(handle, { mode: 'discover', n: 10, record: false, cutoffAt: cutoff });
  assert.ok(mbids(r).includes(REC_UNKNOWN), JSON.stringify(mbids(r)));
  for (const it of r.items) {
    const played = handle.main.prepare('SELECT count(*) AS n FROM play WHERE track_id=? AND played_at < ?').get(it.track_id, cutoff).n;
    assert.equal(played, 0, `${it.recording_mbid} was already played`);
  }
});

test('#13 evaluation at cutoff_at ignores hates and plays from after the cutoff', { todo: 'J18' }, async () => {
  const cutoff = 1_800_000_000;
  const laterPlay = withArtistMbid(H.listen({ at: 1_850_000_000, msid: 'c2', artist: 'Light', title: 'Unknown', mapped: REC_UNKNOWN }), ARTIST_C);
  const run = async (hateCreated) => {
    const { handle } = await library({
      feedback: [{ recording_mbid: REC_UNKNOWN, score: -1, created: hateCreated }],
      extraListens: [laterPlay],
    });
    return mbids(await recommend(handle, { mode: 'discover', n: 10, record: false, cutoffAt: cutoff, eval: true }));
  };
  assert.ok((await run(1_900_000_000)).includes(REC_UNKNOWN), 'a hate and a play after the cutoff must not hide the recording');
  assert.ok(!(await run(1_750_000_000)).includes(REC_UNKNOWN), 'a hate before the cutoff hides it');
});

test('#4 a seed with both a name and a Spotify URI resolves by name', { todo: 'J19' }, async () => {
  const { handle } = await library();
  const r = await recommend(handle, { mode: 'discover', n: 5, record: false, seeds: [{ name: 'Light', uri: 'spotify:artist:abc' }] });
  assert.deepEqual(r.unresolved, []);
});

test('#9 the MCP server reads without writing: a missing online DB is not created', async () => {
  const { handle, dbPath, configDir, paths } = await library();
  handle.close();
  for (const f of [paths.onlinePath, paths.onlinePath + '-wal', paths.onlinePath + '-shm']) rmSync(f, { force: true });
  const r = await createCore({ dbPath, configDir }).callTool('recommend', { mode: 'discover', n: 3 });
  assert.ok(Array.isArray(r.items));
  assert.equal(existsSync(paths.onlinePath), false);
});

test('#7 dedup refuses to merge plays whose MBIDs differ or whose ISRCs differ', { todo: 'J16' }, async () => {
  const merged = async (a, b) => {
    const { handle } = await H.freshDb();
    ingestListens(handle.main, [
      H.listen({ at: 5000, msid: 'd1', artist: 'Same', title: 'Song', via: 'lastfm', ...a }),
      H.listen({ at: 5030, msid: 'd2', artist: 'Same', title: 'Song', via: 'spotify', ...b }),
    ]);
    matchPlays(handle.main);
    dedupPlays(handle.main);
    return handle.main.prepare('SELECT count(*) AS c FROM play WHERE canonical_play_id IS NOT NULL').get().c === 1;
  };
  assert.equal(await merged({ mapped: ARTIST_M }, { mapped: '22222222-2222-4222-8222-222222222222' }), false, 'MBID conflict');
  assert.equal(await merged({ isrc: 'USAAA0000001' }, { isrc: 'USBBB0000002' }), false, 'ISRC conflict');
  assert.equal(await merged({}, {}), true, 'same names, no IDs');
});
