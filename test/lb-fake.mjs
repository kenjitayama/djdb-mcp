// A fake ListenBrainz HTTP server for tests, written from the server source
// (metabrainz/listenbrainz-server: listenstore/timescale_listenstore.py fetch_listens,
// webserver/views/api.py, feedback_api.py, popularity_api.py).
//
// - /1/user/<u>/listens: min_ts and max_ts are exclusive. With min_ts the server takes the
//   OLDEST `count` rows after it (ASC) and returns them newest first. Without min_ts it takes
//   the newest `count` rows before max_ts. count is capped at 1000.
// - get-feedback returns { feedback, count: <rows in this page>, total_count, offset }.
// - Any endpoint listed in `fail` answers 503.
import { createListenBrainzClient } from '../lib/listenbrainz.mjs';

const MAX = 1000;

export function lbFetch(data = {}) {
  const { user = 'tester', listens = [], feedback = [], similar = {}, popularity = {}, tops = {}, fail = {} } = data;
  const calls = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const failed = (kind, key) => fail[kind] === true || (Array.isArray(fail[kind]) && fail[kind].includes(key));
  const f = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method || 'GET';
    calls.push({ method, path: u.pathname, params: Object.fromEntries(u.searchParams), body: init.body ?? null });
    const p = u.pathname;
    if (p === '/1/validate-token') return json({ code: 200, message: 'Token valid.', valid: true, user_name: user });
    let m = p.match(/^\/1\/user\/([^/]+)\/listens$/);
    if (m) {
      if (failed('listens')) return json({ error: 'paused' }, 503);
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
      const count = Math.min(Number(u.searchParams.get('count') || 25), MAX);
      const offset = Number(u.searchParams.get('offset') || 0);
      const page = feedback.slice(offset, offset + count);
      return json({ feedback: page, count: page.length, total_count: feedback.length, offset });
    }
    if (p === '/similar-artists/json') {
      const mbid = u.searchParams.get('artist_mbid');
      if (failed('similar', mbid)) return json({ error: 'paused' }, 503);
      return json(similar[mbid] || []);
    }
    if (p === '/1/popularity/artist' && method === 'POST') {
      if (failed('popularity')) return json({ error: 'paused' }, 503);
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
      return json(tops[mbid] || []);
    }
    return json({ error: `fake LB: no route for ${method} ${p}` }, 404);
  };
  f.calls = calls;
  return f;
}

/** The real client over the fake server. `client.fetch.calls` lists every request. */
export function fakeClient(data = {}, opts = {}) {
  const fetch = lbFetch(data);
  const client = createListenBrainzClient({ fetch, token: 'test-token', sleep: async () => {}, ...opts });
  client.fetch = fetch;
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
