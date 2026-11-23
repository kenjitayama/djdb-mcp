// Whether a cached playback ID or a miss still describes the main DB track.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameRecording } from '../lib/online.mjs';

const M = '11111111-1111-4111-8111-111111111111';
const row = (over = {}) => ({ recording_mbid: null, isrc: 'USAAA0000001', title_norm: 'song', ...over });

test('a row recorded without an MBID matches by ISRC and title only while the track has no MBID either', () => {
  assert.equal(sameRecording(row(), { mbid: null, isrcs: ['USAAA0000001'], title_norm: 'song' }), true);
  assert.equal(sameRecording(row(), { mbid: M, isrcs: ['USAAA0000001'], title_norm: 'song' }), false);
  assert.equal(sameRecording(row({ recording_mbid: M }), { mbid: M, isrcs: [], title_norm: 'other' }), true);
});
