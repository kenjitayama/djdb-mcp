import { createHash } from 'node:crypto';
import { DjdbError } from './errors.mjs';
import { normalizeArtist, normalizeTitle } from './normalize.mjs';

export const LB_API = 'https://api.listenbrainz.org';
export const LB_LABS = 'https://labs.api.listenbrainz.org';
/** Must be one of the values labs similar-artists accepts; any other value is a 400. */
export const DEFAULT_SIMILAR_ALGORITHM =
  'session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30';
export const USER_AGENT = 'djdb-mcp/0.2.0 (https://github.com/kenjitayama/djdb-mcp)';
export const MAX_ITEMS_PER_GET = 1000;
/** ListenBrainz asks clients to stay near one request per second. */
export const MIN_REQUEST_INTERVAL_MS = 1000;

export function createListenBrainzClient(opts = {}) {
  const fetchImpl = opts.fetch || globalThis.fetch;
  const base = opts.baseUrl || LB_API;
  const labs = opts.labsUrl || LB_LABS;
  const token = opts.token || null;
  const userAgent = opts.userAgent || USER_AGENT;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now || Date.now;
  const minInterval = opts.minIntervalMs ?? MIN_REQUEST_INTERVAL_MS;
  const similarAlgorithm = opts.similarAlgorithm || DEFAULT_SIMILAR_ALGORITHM;
  let nextAt = 0;

  function headers(extra = {}) {
    const h = { 'User-Agent': userAgent, Accept: 'application/json', ...extra };
    if (token) h.Authorization = `Token ${token}`;
    return h;
  }

  /** Waits so requests are at least minInterval apart, longer when X-RateLimit-Remaining hits 0. */
  async function paced(url, init) {
    const wait = nextAt - now();
    if (wait > 0) await sleep(wait);
    const res = await fetchImpl(url, { ...init, headers: { ...headers(init.headers), ...init.headers } });
    nextAt = now() + minInterval;
    const remaining = res.headers?.get?.('X-RateLimit-Remaining');
    const resetIn = Number(res.headers?.get?.('X-RateLimit-Reset-In'));
    if (remaining === '0' && resetIn > 0) nextAt = Math.max(nextAt, now() + resetIn * 1000);
    return res;
  }

  async function request(url, init = {}, { retries = 3 } = {}) {
    let last;
    for (let i = 0; i <= retries; i++) {
      const res = await paced(url, init);
      if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
        last = res;
        const ra = Number(res.headers?.get?.('Retry-After')) || 0;
        await sleep(Math.min((ra > 0 ? ra : 2 ** i) * 1000, 15_000));
        continue;
      }
      return res;
    }
    return last;
  }

  /**
   * A 2xx whose body is not JSON, or not the shape `valid` expects, is lb_bad_response. It is thrown
   * before the caller changes anything, so a degraded server cannot empty a set or poison the cache.
   */
  async function json(url, init, label, valid) {
    const res = await request(url, init);
    const text = await res.text();
    let body = null;
    let parsed = true;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; parsed = false; }
    if (res.ok && (!parsed || (valid && !valid(body)))) throw badResponse(label, res.status, 'an unexpected body');
    if (!res.ok) {
      const err = new DjdbError(
        res.status === 401 ? 'lb_unauthorized' : res.status === 404 ? 'lb_not_found' : 'lb_http',
        `${label || 'ListenBrainz'} HTTP ${res.status}`,
        res.status === 503 ? 'ListenBrainz may be paused; retry later or use the last cache.' : undefined,
      );
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  async function validateToken() {
    if (!token) throw new DjdbError('lb_token_missing', 'No ListenBrainz token configured', 'Set LISTENBRAINZ_TOKEN or run djdb init with a token.');
    const body = await json(`${base}/1/validate-token`, {}, 'validate-token', (b) => typeof b?.valid === 'boolean');
    return { valid: !!body?.valid, user: body?.user_name || body?.user || null, raw: body };
  }

  /**
   * Pages /listens. min_ts and max_ts are exclusive and cannot be combined.
   * With minTs it pages forward: the server returns the oldest `count` listens after min_ts,
   * and the next min_ts is the page's newest second - 1. Without minTs it pages backward from
   * maxTs (or now): the next max_ts is the page's oldest second + 1. Re-read listens in a shared
   * second are absorbed by UNIQUE(source_key). If more than `count` listens share one second the
   * boundary cannot move; the rest of that second is skipped and onWarn is called.
   */
  async function *iterListens(user, { minTs, maxTs, count = MAX_ITEMS_PER_GET, onWarn = () => {} } = {}) {
    const size = Math.min(count, MAX_ITEMS_PER_GET);
    const forward = minTs != null;
    let cursor = forward ? minTs : maxTs ?? null;
    for (;;) {
      const u = new URL(`${base}/1/user/${encodeURIComponent(user)}/listens`);
      u.searchParams.set('count', String(size));
      if (cursor != null) u.searchParams.set(forward ? 'min_ts' : 'max_ts', String(cursor));
      const body = await json(u, {}, 'listens', isListensPage);
      const listens = body.payload.listens;
      if (listens.length === 0) return;
      yield listens;
      if (listens.length < size) return;
      const ts = listens.map((l) => Math.floor(Number(l.listened_at)));
      if (forward) {
        const newest = Math.max(...ts);
        let next = newest - 1;
        if (next <= cursor) {
          onWarn({ code: 'lb_same_second', second: newest, message: `more than ${size} listens at ${newest}; the rest of that second was skipped` });
          next = newest;
        }
        cursor = next;
      } else {
        const oldest = Math.min(...ts);
        let next = oldest + 1;
        if (cursor != null && next >= cursor) {
          onWarn({ code: 'lb_same_second', second: oldest, message: `more than ${size} listens at ${oldest}; the rest of that second was skipped` });
          next = oldest;
        }
        cursor = next;
      }
    }
  }

  async function *iterFeedback(user, { count = MAX_ITEMS_PER_GET } = {}) {
    let offset = 0;
    for (;;) {
      const u = new URL(`${base}/1/feedback/user/${encodeURIComponent(user)}/get-feedback`);
      u.searchParams.set('count', String(Math.min(count, MAX_ITEMS_PER_GET)));
      u.searchParams.set('offset', String(offset));
      const body = await json(u, {}, 'feedback', isFeedbackPage);
      const rows = body.feedback ?? body.payload.feedback;
      // count is this page's length; total_count is the whole set, and the pages add up to it.
      // A short page is not the end: paging stops at total_count, and an empty page before it means
      // the set was cut off.
      const total = body.total_count ?? body.payload.total_count;
      if (rows.length === 0) {
        if (offset < total) throw badResponse('feedback', 200, `no rows at offset ${offset} of total_count ${total}`);
        return;
      }
      yield rows;
      offset += rows.length;
      if (offset >= total) return;
    }
  }

  async function similarArtists(artistMbid, algorithm = similarAlgorithm) {
    const u = new URL(`${labs}/similar-artists/json`);
    u.searchParams.set('artist_mbids', artistMbid);
    u.searchParams.set('algorithm', algorithm);
    return json(u, {}, 'similar-artists', rowsWith('artist_mbid'));
  }

  async function artistPopularity(artistMbids) {
    return json(`${base}/1/popularity/artist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ artist_mbids: artistMbids }),
    }, 'popularity/artist', rowsWith('artist_mbid'));
  }

  async function topRecordingsForArtist(artistMbid) {
    return json(`${base}/1/popularity/top-recordings-for-artist/${encodeURIComponent(artistMbid)}`, {}, 'top-recordings', rowsWith('recording_mbid'));
  }

  return {
    base,
    labs,
    similarAlgorithm,
    validateToken,
    iterListens,
    iterFeedback,
    similarArtists,
    artistPopularity,
    topRecordingsForArtist,
  };
}

function badResponse(label, status, what) {
  const err = new DjdbError(
    'lb_bad_response',
    `${label || 'ListenBrainz'} HTTP ${status} with ${what}`,
    'ListenBrainz may be degraded. Nothing was changed; run djdb refresh again later.',
  );
  err.status = status;
  return err;
}

// Body checks, from the shapes the live API returned on 2026-11-23. They only require what every
// live row had, so a degraded server is caught without refusing real data.
const isObject = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
const rowsWith = (key) => (b) => Array.isArray(b) && b.every((r) => isObject(r) && typeof r[key] === 'string');

function isListensPage(b) {
  const listens = b?.payload?.listens;
  return Array.isArray(listens) && listens.every((l) => isObject(l) && Number.isFinite(Number(l.listened_at)) && isObject(l.track_metadata));
}

function isFeedbackPage(b) {
  const rows = b?.feedback ?? b?.payload?.feedback;
  const total = b?.total_count ?? b?.payload?.total_count;
  return Array.isArray(rows) && typeof total === 'number' && rows.every((r) => isObject(r) && typeof r.score === 'number');
}

/** Convert an LB listen into the fields we insert into `play`. */
export function listenToPlayFields(listen, { viaVersion = 1, originVersion = 1 } = {}) {
  const meta = listen.track_metadata || {};
  const info = meta.additional_info || {};
  const mapping = meta.mbid_mapping || {};
  const listenedAt = Math.floor(Number(listen.listened_at));
  const msid = (listen.recording_msid || info.recording_msid || '').toLowerCase();
  const sourceKey = `lb:${listenedAt}|${msid || nomssidFrom(listenedAt, meta)}`;
  const via = inferVia(info);
  const origin = inferOrigin(info);
  const submitted = info.recording_mbid || null;
  const mapped = mapping.recording_mbid || listen.recording_mbid || null;
  return {
    source_key: sourceKey,
    origin,
    origin_version: originVersion,
    via,
    via_version: viaVersion,
    played_at: listenedAt,
    ts_quality: 'ok',
    raw_artist: meta.artist_name || '',
    raw_title: meta.track_name || '',
    raw_album: meta.release_name ?? null,
    raw_duration_ms: info.duration_ms ?? (info.duration != null ? Math.round(Number(info.duration) * 1000) : null),
    submitted_recording_mbid: submitted,
    raw_ext_id: info.spotify_id || info.origin_url || null,
    raw_isrc: info.isrc || null,
    raw_json: JSON.stringify(listen),
    lb_recording_mbid: mapped || null,
    lb_mapping_at: mapped ? Math.floor(Date.now() / 1000) : null,
    artist_mbids: info.artist_mbids || mapping.artist_mbids || [],
  };
}

/**
 * Fallback recording id when ListenBrainz did not assign a recording_msid.
 *
 * The v11 source_key form is `lb:<listened_at>|<recording_msid>` (msid lowercased).
 * When recording_msid is missing, the second field is this fallback (approved):
 *
 *   nomssid:<hex>
 *
 * `<hex>` is the first 32 lowercase hex characters of SHA-256 over the UTF-8 string
 *
 *   <listened_at>|<normalizeArtist(artist_name)>|<normalizeTitle(track_name)>|<normalizeTitle(release_name)>
 *
 * where `<listened_at>` is the integer Unix timestamp in decimal, and a missing
 * name is the empty string. The same listened_at + normalized names always
 * produce the same key; raw capitalization and punctuation do not change it.
 */
export function nomssidFrom(listenedAt, meta = {}) {
  const payload = [
    String(Number(listenedAt)),
    normalizeArtist(meta.artist_name || ''),
    normalizeTitle(meta.track_name || ''),
    normalizeTitle(meta.release_name || ''),
  ].join('|');
  const hex = createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 32);
  return `nomssid:${hex}`;
}

function inferVia(info) {
  const s = String(info.music_service || info.submission_client || info.media_player || '').toLowerCase();
  if (/last\.?fm/.test(s)) return 'lb:lastfm';
  if (/spotify/.test(s)) return 'lb:spotify';
  if (s) return 'lb:' + s.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return 'lb:unknown';
}

function inferOrigin(info) {
  const s = String(info.music_service_name || info.music_service || info.media_player || '').trim();
  return s || 'unknown';
}

export function feedbackToRow(f) {
  const mbid = f.recording_mbid || f.mbid || null;
  const msid = (f.recording_msid || f.msid || null)?.toLowerCase?.() || f.recording_msid || null;
  const score = Number(f.score);
  const created = Number(f.created ?? f.created_ts ?? 0);
  if (score !== 1 && score !== -1) return null;
  if (!mbid && !msid) return null;
  const recording_key = mbid ? `mbid:${mbid}` : `msid:${msid}`;
  return { recording_key, recording_mbid: mbid, recording_msid: msid, score, created };
}
