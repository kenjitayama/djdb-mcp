// The ListenBrainz client's requests and how it treats the bodies it gets back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClient, SIMILAR_ALGORITHMS } from './lb-fake.mjs';
import { DEFAULT_SIMILAR_ALGORITHM } from '../lib/listenbrainz.mjs';

const MBID = '11111111-1111-4111-8111-111111111111';

test('similar-artists is asked with artist_mbids and an algorithm the labs API accepts', async () => {
  assert.ok(SIMILAR_ALGORITHMS.includes(DEFAULT_SIMILAR_ALGORITHM), DEFAULT_SIMILAR_ALGORITHM);
  const client = fakeClient({ similar: { [MBID]: [{ artist_mbid: '22222222-2222-4222-8222-222222222222', name: 'Other', score: 5 }] } });
  const body = await client.similarArtists(MBID);
  assert.deepEqual(body.map((x) => x.name), ['Other']);
  const call = client.fetch.calls.find((c) => c.path === '/similar-artists/json');
  assert.deepEqual(call.params, { artist_mbids: MBID, algorithm: DEFAULT_SIMILAR_ALGORITHM });
});
