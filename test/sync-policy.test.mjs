// The approved listen sync policy. These must keep passing through every sync change.
// - The first sync imports a ListenBrainz export. Without one it fails with lb_export_required.
// - Later syncs ask /listens for deltas with min_ts = last synced listened_at - 3600.
// - Paging the whole history through /listens happens only with --listens-full-history.
// - Re-fetched overlap is absorbed by UNIQUE(source_key).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as H from './helpers.mjs';
import { fakeClient } from './lb-fake.mjs';
import { ingestListens, syncListens, DELTA_OVERLAP_SEC } from '../lib/sync.mjs';
import { setMeta } from '../lib/db.mjs';

const listensCalls = (client) => client.fetch.calls.filter((c) => c.path.endsWith('/listens'));

async function syncedDb() {
  const db = await H.freshDb();
  ingestListens(db.handle.main, [H.listen({ at: 10_000, msid: 'seed', artist: 'A', title: 'T' })]);
  setMeta(db.handle.main, 'lb_listens_synced_max_ts', '10000');
  setMeta(db.handle.main, 'lb_export_imported_at', '1');
  return db;
}

test('policy: the first sync without an export or --listens-full-history fails and calls nothing', async () => {
  const { handle } = await H.freshDb();
  const client = fakeClient({ listens: [H.listen({ at: 5, msid: 'x', artist: 'A', title: 'T' })] });
  await assert.rejects(syncListens(handle.main, client, 'tester', {}), { code: 'lb_export_required' });
  assert.equal(listensCalls(client).length, 0);
});

test('policy: a delta sync starts at min_ts = last synced listened_at - 3600 and never sends max_ts', async () => {
  const { handle } = await syncedDb();
  const client = fakeClient({ listens: [11_000, 12_000, 13_000].map((at) => H.listen({ at, msid: `n${at}`, artist: 'A', title: `T${at}` })) });
  const r = await syncListens(handle.main, client, 'tester', {});
  assert.equal(DELTA_OVERLAP_SEC, 3600);
  const calls = listensCalls(client);
  assert.equal(calls[0].params.min_ts, String(10_000 - 3600));
  assert.ok(calls.every((c) => c.params.max_ts == null));
  assert.equal(r.inserted, 3);
  assert.equal(r.last_ts, 13_000);
});

test('policy: listens re-fetched by the overlap are absorbed by UNIQUE(source_key)', async () => {
  const { handle } = await syncedDb();
  const client = fakeClient({
    listens: [
      H.listen({ at: 10_000, msid: 'seed', artist: 'A', title: 'T' }),
      H.listen({ at: 11_000, msid: 'n1', artist: 'A', title: 'T1' }),
    ],
  });
  const r = await syncListens(handle.main, client, 'tester', {});
  assert.equal(r.inserted, 1);
  assert.equal(handle.main.prepare('SELECT count(*) AS n FROM play').get().n, 2);
});

test('policy: --listens-full-history pages the whole history without min_ts', async () => {
  const { handle } = await H.freshDb();
  const client = fakeClient({ listens: [100, 200, 300].map((at) => H.listen({ at, msid: `f${at}`, artist: 'A', title: `T${at}` })) });
  const r = await syncListens(handle.main, client, 'tester', { listensFullHistory: true });
  assert.equal(r.inserted, 3);
  assert.ok(listensCalls(client).every((c) => c.params.min_ts == null));
});
