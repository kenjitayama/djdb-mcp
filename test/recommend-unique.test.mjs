// A recording credited to two artists can be in both artists' top recordings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as H from './helpers.mjs';
import { fakeClient, topRecording } from './lb-fake.mjs';
import { withArtistMbid } from './library.mjs';
import { refresh } from '../lib/refresh.mjs';
import { recommend } from '../lib/recommend.mjs';

const HEAVY = '11111111-1111-4111-8111-111111111111';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';
const SHARED = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const D_ONLY = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const DAY = 86400;

test('recommend returns each track once, even when two artists share a top recording', async () => {
  const listens = [];
  for (let i = 0; i < 40; i++) {
    listens.push(withArtistMbid(H.listen({ at: 1_700_000_000 + i * DAY, msid: `m${i}`, artist: 'Heavy', title: `H${i % 3}` }), HEAVY));
  }
  const client = fakeClient({
    listens,
    similar: { [HEAVY]: [{ artist_mbid: C, name: 'Cee', score: 2 }, { artist_mbid: D, name: 'Dee', score: 1 }] },
    tops: {
      [C]: [topRecording({ artistMbid: C, artist: 'Cee & Dee', mbid: SHARED, title: 'Together', listens: 900 })],
      [D]: [
        topRecording({ artistMbid: D, artist: 'Cee & Dee', mbid: SHARED, title: 'Together', listens: 900 }),
        topRecording({ artistMbid: D, artist: 'Dee', mbid: D_ONLY, title: 'Alone', listens: 500 }),
      ],
    },
  });
  const { handle } = await H.freshDb({ client });
  try {
    const r = await refresh(handle, { client, skipTokenCheck: true, listensFullHistory: true });
    assert.equal(r.ok, true, JSON.stringify(r.results));
    const rec = await recommend(handle, { mode: 'discover', n: 5, record: false, cutoffAt: 2_000_000_000 });
    const ids = rec.items.map((i) => i.track_id);
    assert.equal(new Set(ids).size, ids.length, JSON.stringify(rec.items.map((i) => [i.artist_id, i.recording_mbid])));
    assert.deepEqual(rec.items.map((i) => i.recording_mbid).sort(), [SHARED, D_ONLY].sort());
  } finally {
    handle.close();
  }
});
