// A small refreshed library shared by the regression and reader tests.
// Heavy artist M (40 days of plays) and light artist C (one play of REC_KNOWN).
// C's top recordings on LB are REC_KNOWN (played) and REC_UNKNOWN (never played, not in the library).
import assert from 'node:assert/strict';
import * as H from './helpers.mjs';
import { fakeClient, topRecording } from './lb-fake.mjs';
import { refresh } from '../lib/refresh.mjs';

export const ARTIST_M = '11111111-1111-4111-8111-111111111111';
export const ARTIST_C = '33333333-3333-4333-8333-333333333333';
export const REC_KNOWN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const REC_UNKNOWN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DAY = 86400;

export const withArtistMbid = (l, mbid) => { l.track_metadata.additional_info.artist_mbids = [mbid]; return l; };

export function libraryClient({ feedback = [], extraListens = [], fail } = {}) {
  const listens = [];
  for (let i = 0; i < 40; i++) {
    listens.push(withArtistMbid(H.listen({ at: 1_700_000_000 + i * DAY, msid: `m${i}`, artist: 'Heavy', title: `H${i % 3}` }), ARTIST_M));
  }
  listens.push(withArtistMbid(H.listen({ at: 1_700_000_000 + 41 * DAY, msid: 'c1', artist: 'Light', title: 'Known', mapped: REC_KNOWN }), ARTIST_C));
  listens.push(...extraListens);
  return fakeClient({
    listens,
    feedback,
    fail,
    similar: { [ARTIST_M]: [{ artist_mbid: ARTIST_C, name: 'Light', score: 1 }] },
    tops: {
      [ARTIST_C]: [
        topRecording({ artistMbid: ARTIST_C, artist: 'Light', mbid: REC_KNOWN, title: 'Known', listens: 900 }),
        topRecording({ artistMbid: ARTIST_C, artist: 'Light', mbid: REC_UNKNOWN, title: 'Unknown', listens: 800 }),
      ],
    },
  });
}

export async function library(opts = {}) {
  const client = libraryClient(opts);
  const db = await H.freshDb({ client });
  const r = await refresh(db.handle, { client, skipTokenCheck: true, listensFullHistory: true });
  assert.equal(r.ok, true, JSON.stringify(r.results));
  return { ...db, client };
}
