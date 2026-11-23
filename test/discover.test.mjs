// discover recommends recordings the user has not heard, as of the cutoff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as H from './helpers.mjs';
import { topRecording } from './lb-fake.mjs';
import { libraryClient, ARTIST_C, REC_UNKNOWN } from './library.mjs';
import { refresh } from '../lib/refresh.mjs';
import { recommend } from '../lib/recommend.mjs';

const REC_LIVE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const REC_OTHER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const cutoffAt = 2_000_000_000;

// extraTops go right after the played REC_KNOWN, ahead of REC_UNKNOWN, since discover keeps one item per artist.
async function libraryWithTops(extraTops, feedback = []) {
  const client = libraryClient({ feedback });
  client.data.tops[ARTIST_C].splice(1, 0, ...extraTops);
  const { handle } = await H.freshDb({ client });
  const r = await refresh(handle, { client, skipTokenCheck: true, listensFullHistory: true });
  assert.equal(r.ok, true, JSON.stringify(r.results));
  return handle;
}

const discover = async (handle) => (await recommend(handle, { mode: 'discover', n: 10, record: false, cutoffAt })).items;

test('discover skips the same song under another recording', async () => {
  const handle = await libraryWithTops([topRecording({ artistMbid: ARTIST_C, artist: 'Light', mbid: REC_LIVE, title: 'Known (Live!)', listens: 950 })]);
  try {
    handle.main.prepare(`UPDATE track SET title_norm='known' WHERE mbid=?`).run(REC_LIVE);
    const items = await discover(handle);
    assert.deepEqual(items.map((i) => i.recording_mbid), [REC_UNKNOWN]);
  } finally {
    handle.close();
  }
});

test('a hate on a catalog recording hides it from the first refresh that registers it', async () => {
  const handle = await libraryWithTops(
    [topRecording({ artistMbid: ARTIST_C, artist: 'Light', mbid: REC_OTHER, title: 'Other', listens: 700 })],
    [{ recording_mbid: REC_UNKNOWN, score: -1, created: 1_000 }],
  );
  try {
    const items = await discover(handle);
    assert.deepEqual(items.map((i) => i.recording_mbid), [REC_OTHER]);
  } finally {
    handle.close();
  }
});

test('discover has no own-play fallback; rediscover keeps it', async () => {
  const client = libraryClient();
  client.data.tops = {};
  const { handle } = await H.freshDb({ client });
  try {
    await refresh(handle, { client, skipTokenCheck: true, listensFullHistory: true });
    assert.deepEqual(await discover(handle), []);
    const re = await recommend(handle, { mode: 'rediscover', n: 10, record: false, cutoffAt });
    assert.ok(re.items.every((i) => i.candidate_source === 'own-plays'), JSON.stringify(re.items));
  } finally {
    handle.close();
  }
});
