// Where a recommended item can be played: from the ID cache at recommend time, or reported by dj-mcp.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { library, REC_UNKNOWN } from './library.mjs';
import { recommend } from '../lib/recommend.mjs';
import { recordExternalIds, explain } from '../lib/online.mjs';

const opts = { mode: 'discover', n: 5, record: true, cutoffAt: 2_000_000_000 };
const playableOf = (online, runId) => online.prepare(
  `SELECT rank, provider, ext_id, play_uri, market, resolved_by, resolved_at FROM rec_item WHERE run_id=? AND ext_id IS NOT NULL ORDER BY rank`,
).all(runId).map((r) => ({ ...r }));

test('a reported Spotify ID is stored for the run and served from the cache next time', async () => {
  const { handle } = await library();
  try {
    const first = await recommend(handle, opts);
    const known = first.items.find((i) => i.recording_mbid === REC_UNKNOWN);
    assert.ok(known, JSON.stringify(first.items));
    assert.equal(known.playable, null);
    const r = recordExternalIds(handle.online, handle.main, first.run_id, [
      { rank: known.rank, provider: 'spotify', status: 'ok', extId: 'sp1', playUri: 'spotify:track:sp1', method: 'isrc' },
    ], { market: 'JP', nowSec: 1234 });
    assert.equal(r.ok, true);
    assert.deepEqual(playableOf(handle.online, first.run_id), [
      { rank: known.rank, provider: 'spotify', ext_id: 'sp1', play_uri: 'spotify:track:sp1', market: 'JP', resolved_by: 'client', resolved_at: 1234 },
    ]);
    const again = recordExternalIds(handle.online, handle.main, first.run_id, [
      { rank: known.rank, provider: 'spotify', status: 'ok', extId: 'sp2', playUri: 'spotify:track:sp2' },
    ], { market: 'JP', nowSec: 1300 });
    assert.equal(again.ok, true);
    assert.equal(playableOf(handle.online, first.run_id)[0].ext_id, 'sp1', 'the first resolution of a run item is kept');

    const second = await recommend(handle, { ...opts, cutoffAt: 2_000_000_100 });
    const k2 = second.items.find((i) => i.recording_mbid === REC_UNKNOWN);
    assert.deepEqual(k2.playable, { provider: 'spotify', ext_id: 'sp1', play_uri: 'spotify:track:sp1', market: 'JP', resolved_by: 'cache' });
    assert.deepEqual(playableOf(handle.online, second.run_id), [
      { rank: k2.rank, provider: 'spotify', ext_id: 'sp1', play_uri: 'spotify:track:sp1', market: 'JP', resolved_by: 'cache', resolved_at: 2_000_000_100 },
    ]);
    const ex = explain(handle.online, second.run_id);
    assert.equal(ex.status, 'ok');
    assert.equal(ex.items.length, second.items.length);
    const exKnown = ex.items.find((i) => i.rank === k2.rank);
    assert.deepEqual([exKnown.ext_id, exKnown.resolved_by], ['sp1', 'cache']);
  } finally {
    handle.close();
  }
});

test('#8 a run and its items are written together: a failed item leaves no run', async () => {
  const { handle } = await library();
  try {
    handle.online.exec(`CREATE TEMP TRIGGER fail_item BEFORE INSERT ON rec_item BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    await assert.rejects(recommend(handle, opts), /injected/);
    assert.equal(handle.online.prepare('SELECT count(*) AS n FROM rec_run').get().n, 0);
    assert.equal(handle.online.isTransaction, false);
    assert.equal(handle.main.isTransaction, false);
  } finally {
    handle.close();
  }
});
