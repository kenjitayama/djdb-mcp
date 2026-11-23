// A fake ListenBrainz HTTP server for tests, written from the server source
// (metabrainz/listenbrainz-server: listenstore/timescale_listenstore.py fetch_listens,
// webserver/views/api.py, feedback_api.py, popularity_api.py).
//
// - /1/user/<u>/listens: min_ts and max_ts are exclusive. With min_ts the server takes the
//   OLDEST `count` rows after it (ASC) and returns them newest first. Without min_ts it takes
//   the newest `count` rows before max_ts. count is capped at 1000.
// - get-feedback returns { feedback, count: <rows in this page>, total_count, offset }.
// - similar-artists (labs) validates like the real API: artist_mbids is required (artist_mbid is
//   not accepted) and algorithm must be one of SIMILAR_ALGORITHMS, else 400. Measured 2026-11-23.
// - Any endpoint listed in `fail` answers 503.
// - `bad: { <kind>: 'html' | 'shape' | [keys] }` answers 200 with an HTML page ('html', or for the listed keys)
//   or with JSON of the wrong shape ('shape'). kinds: listens, feedback, similar, popularity, tops.
// - `rateLimit: { remaining, resetIn }` adds X-RateLimit-Remaining / X-RateLimit-Reset-In to every response.
// Data is read per request, so a test can change `client.data` between calls.
import { createListenBrainzClient } from '../lib/listenbrainz.mjs';

const MAX = 1000;

/** The algorithm values labs similar-artists accepted on 2026-11-23 (from its 400 body). */
export const SIMILAR_ALGORITHMS = [
  'session_based_days_1800_session_300_contribution_3_threshold_10_limit_100_filter_True_skip_30',
  'session_based_days_75_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30',
  'session_based_days_9000_session_300_contribution_5_threshold_15_limit_50_skip_30',
  'session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30',
  'session_based_days_1825_session_300_contribution_3_threshold_10_limit_100_filter_True_skip_30',
  'session_based_days_7500_session_300_contribution_3_threshold_10_limit_100_filter_True_skip_30',
];

export function lbFetch(data = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    const { user = 'tester', listens = [], feedback = [], similar = {}, popularity = {}, tops = {}, fail = {}, bad = {}, rateLimit } = data;
    const headers = { 'content-type': 'application/json' };
    if (rateLimit) Object.assign(headers, { 'X-RateLimit-Remaining': String(rateLimit.remaining), 'X-RateLimit-Reset-In': String(rateLimit.resetIn) });
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
    const failed = (kind, key) => fail[kind] === true || (Array.isArray(fail[kind]) && fail[kind].includes(key));
    const badBody = (kind, key) => {
      const b = bad[kind];
      if (b === 'shape') return json({ unexpected: true });
      if (b === 'html' || (Array.isArray(b) && b.includes(key))) return new Response('<html><body>Service unavailable</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
      return null;
    };
    const u = new URL(String(url));
    const method = init.method || 'GET';
    calls.push({ method, path: u.pathname, params: Object.fromEntries(u.searchParams), body: init.body ?? null });
    const p = u.pathname;
    if (p === '/1/validate-token') return json({ code: 200, message: 'Token valid.', valid: true, user_name: user });
    let m = p.match(/^\/1\/user\/([^/]+)\/listens$/);
    if (m) {
      if (failed('listens')) return json({ error: 'paused' }, 503);
      const b = badBody('listens'); if (b) return b;
      const count = Math.min(Number(u.searchParams.get('count') || 25), MAX);
      const min = u.searchParams.get('min_ts');
      const max = u.searchParams.get('max_ts');
      if (min != null && max != null) return json({ code: 400, error: 'You may only specify min_ts or max_ts, but not both.' }, 400);
      let rows = listens.filter((l) => (min == null || l.listened_at > Number(min)) && (max == null || l.listened_at < Number(max)));
      rows.sort((a, b) => (min != null ? a.listened_at - b.listened_at : b.listened_at - a.listened_at));
      rows = rows.slice(0, count);
      if (min != null) rows.reverse();
      return json({ payload: { count: rows.length, listens: rows, user_id: decodeURIComponent(m[1]) } });
    }
    m = p.match(/^\/1\/feedback\/user\/[^/]+\/get-feedback$/);
    if (m) {
      if (failed('feedback')) return json({ error: 'paused' }, 503);
      const b = badBody('feedback'); if (b) return b;
      const count = Math.min(Number(u.searchParams.get('count') || 25), MAX);
      const offset = Number(u.searchParams.get('offset') || 0);
      const page = feedback.slice(offset, offset + count);
      return json({ feedback: page, count: page.length, total_count: feedback.length, offset });
    }
    if (p === '/similar-artists/json') {
      const mbid = u.searchParams.get('artist_mbids');
      const errors = [];
      if (!mbid) errors.push('artist_mbids field required');
      if (!SIMILAR_ALGORITHMS.includes(u.searchParams.get('algorithm'))) errors.push('algorithm value is not a valid enumeration member');
      if (errors.length) return new Response(`<p>${errors.length} validation errors for SimilarArtistsViewerInput: ${errors.join('; ')}</p>`, { status: 400, headers: { 'content-type': 'text/html' } });
      if (failed('similar', mbid)) return json({ error: 'paused' }, 503);
      const b = badBody('similar', mbid); if (b) return b;
      return json(similar[mbid] || []);
    }
    if (p === '/1/popularity/artist' && method === 'POST') {
      if (failed('popularity')) return json({ error: 'paused' }, 503);
      const b = badBody('popularity'); if (b) return b;
      const ids = JSON.parse(init.body).artist_mbids;
      return json(ids.map((id) => ({
        artist_mbid: id,
        total_listen_count: popularity[id]?.listens ?? 500,
        total_user_count: popularity[id]?.users ?? 50,
      })));
    }
    m = p.match(/^\/1\/popularity\/top-recordings-for-artist\/([^/]+)$/);
    if (m) {
      const mbid = decodeURIComponent(m[1]);
      if (failed('tops', mbid)) return json({ error: 'paused' }, 503);
      const b = badBody('tops', mbid); if (b) return b;
      return json(tops[mbid] || []);
    }
    return json({ error: `fake LB: no route for ${method} ${p}` }, 404);
  };
  f.calls = calls;
  return f;
}

/** The real client over the fake server. `client.fetch.calls` lists every request; `client.data` is the server's data. */
export function fakeClient(data = {}, opts = {}) {
  const fetch = lbFetch(data);
  const client = createListenBrainzClient({ fetch, token: 'test-token', sleep: async () => {}, ...opts });
  client.fetch = fetch;
  client.data = data;
  return client;
}

/** A top-recordings row in the shape /1/popularity/top-recordings-for-artist returns. */
export function topRecording({ artistMbid, artist, mbid, title, release = null, listens = 100 }) {
  return {
    artist_mbids: [artistMbid],
    artist_name: artist,
    recording_mbid: mbid,
    recording_name: title,
    release_mbid: null,
    release_name: release,
    total_listen_count: listens,
    total_user_count: Math.max(1, Math.floor(listens / 10)),
    length: 200000,
  };
}
