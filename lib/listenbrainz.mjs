import { createHash } from 'node:crypto';
import { DjdbError } from './errors.mjs';
import { normalizeArtist, normalizeTitle } from './normalize.mjs';

export const LB_API = 'https://api.listenbrainz.org';
export const LB_LABS = 'https://labs.api.listenbrainz.org';
export const DEFAULT_SIMILAR_ALGORITHM =
  'session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True';
export const USER_AGENT = 'djdb-mcp/0.1.0 (https://github.com/kenjitayama/djdb-mcp)';
export const MAX_ITEMS_PER_GET = 1000;

export function createListenBrainzClient(opts = {}) {
  const fetchImpl = opts.fetch || globalThis.fetch;
  const base = opts.baseUrl || LB_API;
  const labs = opts.labsUrl || LB_LABS;
  const token = opts.token || null;
  const userAgent = opts.userAgent || USER_AGENT;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const similarAlgorithm = opts.similarAlgorithm || DEFAULT_SIMILAR_ALGORITHM;

  function headers(extra = {}) {
    const h = { 'User-Agent': userAgent, Accept: 'application/json', ...extra };
    if (token) h.Authorization = `Token ${token}`;
    return h;
  }

  async function request(url, init = {}, { retries = 3 } = {}) {
    let last;
    for (let i = 0; i <= retries; i++) {
      const res = await fetchImpl(url, { ...init, headers: { ...headers(init.headers), ...init.headers } });
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

  async function json(url, init, label) {
    const res = await request(url, init);
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
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
    const body = await json(`${base}/1/validate-token`, {}, 'validate-token');
    return { valid: !!body?.valid, user: body?.user_name || body?.user || null, raw: body };
  }

  async function *iterListens(user, { minTs, maxTs, count = MAX_ITEMS_PER_GET } = {}) {
    let cursorMax = maxTs;
    for (;;) {
      const u = new URL(`${base}/1/user/${encodeURIComponent(user)}/listens`);
      u.searchParams.set('count', String(Math.min(count, MAX_ITEMS_PER_GET)));
      if (cursorMax != null) u.searchParams.set('max_ts', String(cursorMax));
      if (minTs != null && cursorMax == null) u.searchParams.set('min_ts', String(minTs));
      const body = await json(u, {}, 'listens');
      const listens = body?.payload?.listens || [];
      if (listens.length === 0) return;
      yield listens;
      const oldest = Math.min(...listens.map((l) => l.listened_at));
      if (listens.length < Math.min(count, MAX_ITEMS_PER_GET)) return;
      if (minTs != null && oldest <= minTs) return;
      cursorMax = oldest;
    }
  }

  async function fetchAllListens(user, opts) {
    const all = [];
    for await (const page of iterListens(user, opts)) all.push(...page);
    return all;
  }

  async function *iterFeedback(user, { count = MAX_ITEMS_PER_GET } = {}) {
    let offset = 0;
    for (;;) {
      const u = new URL(`${base}/1/feedback/user/${encodeURIComponent(user)}/get-feedback`);
      u.searchParams.set('count', String(Math.min(count, MAX_ITEMS_PER_GET)));
      u.searchParams.set('offset', String(offset));
      const body = await json(u, {}, 'feedback');
      const rows = body?.feedback || body?.payload?.feedback || [];
      if (rows.length === 0) return;
      yield rows;
      offset += rows.length;
      const total = body?.count ?? body?.payload?.count;
      if (typeof total === 'number' && offset >= total) return;
      if (rows.length < Math.min(count, MAX_ITEMS_PER_GET)) return;
    }
  }

  async function fetchAllFeedback(user) {
    const all = [];
    for await (const page of iterFeedback(user)) all.push(...page);
    return all;
  }

  async function similarArtists(artistMbid, algorithm = similarAlgorithm) {
    const u = new URL(`${labs}/similar-artists/json`);
    u.searchParams.set('artist_mbid', artistMbid);
    u.searchParams.set('algorithm', algorithm);
    return json(u, {}, 'similar-artists');
  }

  async function artistPopularity(artistMbids) {
    return json(`${base}/1/popularity/artist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ artist_mbids: artistMbids }),
    }, 'popularity/artist');
  }

  async function topRecordingsForArtist(artistMbid) {
    return json(`${base}/1/popularity/top-recordings-for-artist/${encodeURIComponent(artistMbid)}`, {}, 'top-recordings');
  }

  async function lbRadioArtist(seedMbid, params = {}) {
    const u = new URL(`${base}/1/lb-radio/artist/${encodeURIComponent(seedMbid)}`);
    u.searchParams.set('mode', params.mode || 'easy');
    if (params.max_similar_artists != null) u.searchParams.set('max_similar_artists', String(params.max_similar_artists));
    if (params.max_recordings_per_artist != null) u.searchParams.set('max_recordings_per_artist', String(params.max_recordings_per_artist));
    if (params.pop_begin != null) u.searchParams.set('pop_begin', String(params.pop_begin));
    if (params.pop_end != null) u.searchParams.set('pop_end', String(params.pop_end));
    return json(u, {}, 'lb-radio');
  }

  return {
    base,
    labs,
    similarAlgorithm,
    validateToken,
    iterListens,
    fetchAllListens,
    iterFeedback,
    fetchAllFeedback,
    similarArtists,
    artistPopularity,
    topRecordingsForArtist,
    lbRadioArtist,
  };
}

/** Convert an LB listen into the fields we insert into `play`. */
export function listenToPlayFields(listen, { viaVersion = 1, originVersion = 1 } = {}) {
  const meta = listen.track_metadata || {};
  const info = meta.additional_info || {};
  const mapping = meta.mbid_mapping || {};
  const listenedAt = Number(listen.listened_at);
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
