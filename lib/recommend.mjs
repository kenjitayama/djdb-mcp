import { createHash } from 'node:crypto';
import { normalizeArtist } from './normalize.mjs';
import { bindCheck, trackLookups, readHighWatermarks, recentExposedTrackIds } from './online.mjs';
import { DjdbError } from './errors.mjs';
import { batch } from './batch.mjs';
import { TOP_RECORDINGS_KEPT } from './popularity.mjs';
import { CATALOG } from './match.mjs';

export const ALGO_VERSION = 'v11';
/**
 * Provisional defaults, to be tuned after evaluation.
 * The v11 design fixes roles and some values (alpha 0.3–0.5, top 3
 * recordings, 180-day era gap, 30-day overlay/miss) but not exact values for
 * every knob. Do not treat these as final.
 */
export const DEFAULT_PARAMS = {
  alpha: 0.4,          // Provisional. teleport; design range 0.3–0.5
  beta: 0.5,           // Provisional. popularity exponent in r/(pop+c)^β
  rho: 0.6,            // Provisional. latest-era share (times s_latest)
  kappa: 10,           // Provisional. era strength n/(n+κ)
  T: 365 * 86400,      // Provisional. recency decay (seconds)
  q: 20,               // Provisional. heavy: top q% of play counts in an era
  m: 3,                // Provisional. heavy: at least m distinct days in that era
  c: 1,                // Provisional. popularity additive constant
  topN: 3,             // specified by the design
  overlayDays: 30,     // specified by the design
  eraGapDays: 180,     // specified by the design
  pprIterations: 50,   // Provisional
  popWinsorLow: 0.05,  // Provisional
  popWinsorHigh: 0.95, // Provisional
  loveBonus: 1,        // Provisional
};

const DAY = 86400;

/**
 * recommend({ mode, n, provider, market, seeds, record })
 * Ranking reads the main DB (plays, graph, popularity, lb_feedback) in one read transaction,
 * so a refresh committing in the middle cannot mix two states into one run.
 * Overlay (recent impressions/queued, ID cache) comes from the online DB.
 * The standalone MCP server passes record:false and does not write the online DB.
 */
export async function recommend(handle, opts = {}) {
  const mode = opts.mode === 'rediscover' ? 'rediscover' : 'discover';
  const n = Math.max(1, Math.min(Number(opts.n) || 20, 100));
  const provider = opts.provider || 'spotify';
  const market = opts.market || 'JP';
  const params = { ...DEFAULT_PARAMS, ...(opts.params || {}) };
  const cutoff = opts.cutoffAt ?? Math.floor((opts.now ? opts.now() : Date.now()) / 1000);
  const record = opts.record !== false;

  if (record && !opts.eval && !handle.online) {
    throw new DjdbError('no_online_db', 'recording a run needs the online DB', "Open with openReader({ online: 'write' }), or pass record: false.");
  }
  if (handle.online) {
    const bind = bindCheck(handle.online, handle.main);
    if (!bind.ok) return { items: [], disabled: true, reason: bind.reason, hint: bind.hint };
  }

  const db = handle.main;
  const ownTxn = !db.isTransaction;
  if (ownTxn) db.exec('BEGIN');
  try {
    const seeds = resolveSeeds(db, opts.seeds || []);
    const eras = splitEras(db, cutoff, params.eraGapDays);
    const tastes = eraTastes(db, eras, cutoff, params);
    const graph = loadGraph(db);
    const v = buildTeleport(tastes, seeds, graph.ids, params);
    const rank = personalizedPageRank(graph, v, params);
    const popAdj = applyPopularity(db, rank, params);
    const heavy = heavyArtists(db, eras, params);
    let eligible;
    if (mode === 'discover') {
      const allHeavy = new Set();
      for (const s of heavy.values()) s.forEach((id) => allHeavy.add(id));
      eligible = [...popAdj.entries()].filter(([id]) => !allHeavy.has(id));
    } else {
      const latest = eras.length ? eras[eras.length - 1] : null;
      const latestHeavy = latest ? (heavy.get(latest.index) || new Set()) : new Set();
      const oldHeavy = new Set();
      for (const e of eras.slice(0, -1)) (heavy.get(e.index) || new Set()).forEach((id) => oldHeavy.add(id));
      // One pass over the latest era.
      const latestCounts = playCounts(latest ? latest.plays : []);
      eligible = [...popAdj.entries()].filter(([id]) => oldHeavy.has(id) && !latestHeavy.has(id) && (latestCounts.get(id) || 0) <= 1);
    }

    const hated = new Set(
      db.prepare(`SELECT track_id FROM lb_feedback WHERE score = -1 AND track_id IS NOT NULL AND created < ?`).all(cutoff)
        .map((r) => r.track_id),
    );

    // Read before the artist walk so a recently shown track does not count toward the 2*n.
    let hwm = { prior_rec_run_max_id: 0, rec_event_max_id: 0 };
    let recent = [];
    if (handle.online && !opts.eval) {
      hwm = readHighWatermarks(handle.online);
      recent = recentExposedTrackIds(handle.online, hwm, { since: cutoff - params.overlayDays * DAY });
    }
    const recentSet = new Set(recent);
    const lookups = trackLookups(db, opts.eval ? null : handle.online);
    const blockedTrack = (trackId) => hated.has(trackId) || (!opts.eval && recentSet.has(trackId));
    const blockedByMiss = (trackId) => !opts.eval && !!handle.online
      && !lookups.cachedId(trackId, provider, market)
      && lookups.activeMiss(trackId, provider, market, cutoff);

    // slice(0, n*2) truncates a fractional end. An unfloored limit is not an array index.
    const limit = Math.floor(n * 2);
    const candidates = expandToRecordings(db, new Map(eligible), {
      mode, topN: params.topN, cutoff, limit, blockedTrack, blockedByMiss,
    });
    const filtered = takeDiverse(candidates, limit, blockedTrack, blockedByMiss);

    if (filtered.length === 0 && mode === 'discover') {
      const nCache = db.prepare(`SELECT count(*) AS n FROM fetch_cache WHERE endpoint='lb:top-recordings'`).get().n;
      const reason = nCache === 0
        ? 'no top-recordings cache and LB popularity looks paused; try djdb refresh later'
        : 'no candidates after filters';
      return { items: [], reason, mode, seeds: seeds.report, eras: summarizeEras(eras), unresolved: seeds.unresolved };
    }

    const items = filtered.map((it, i) => {
      const idn = lookups.identity(it.track_id) || { mbid: null, isrcs: [], title_norm: '' };
      const tr = lookups.title(it.track_id);
      const cache = handle.online && !opts.eval ? lookups.cachedId(it.track_id, provider, market) : null;
      const row = {
        rank: i + 1,
        pre_rank: it.pre_rank ?? i + 1,
        candidate_source: it.source,
        artist_id: it.artist_id,
        track_id: it.track_id,
        title: tr?.title,
        artist_credit: tr?.artist_credit,
        recording_mbid: idn.mbid,
        isrc: idn.isrcs[0] ?? null,
        title_norm: idn.title_norm,
        score: it.score,
        components: it.components,
        playable: cache ? { provider, ext_id: cache.ext_id, play_uri: cache.play_uri, market: cache.market, resolved_by: 'cache' } : null,
      };
      return row;
    });

    const paramsJson = {
      mode, n, provider, market, cutoff_at: cutoff,
      alpha: params.alpha, beta: params.beta, rho: params.rho, kappa: params.kappa, T: params.T, q: params.q, m: params.m,
      eras: summarizeEras(eras),
      seeds: seeds.report,
      prior_rec_run_max_id: hwm.prior_rec_run_max_id,
      rec_event_max_id: hwm.rec_event_max_id,
    };
    const paramsHash = createHash('sha256').update(JSON.stringify(paramsJson)).digest('hex');

    let runId = null;
    if (record && handle.online && !opts.eval) {
      batch(handle.online, () => {
        const ins = handle.online.prepare(
          `INSERT INTO rec_run (created_at, mode, algo_version, params_hash, params_json) VALUES (?,?,?,?,?)`,
        ).run(cutoff, mode, ALGO_VERSION, paramsHash, JSON.stringify(paramsJson));
        runId = Number(ins.lastInsertRowid);
        const add = handle.online.prepare(
          `INSERT INTO rec_item (run_id, rank, pre_rank, candidate_source, artist_id, track_id, recording_mbid, isrc, title_norm, score, components_json,
                                 provider, ext_id, play_uri, market, resolved_by, resolved_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        );
        for (const it of items) {
          const p = it.playable;
          add.run(runId, it.rank, it.pre_rank, it.candidate_source, it.artist_id, it.track_id, it.recording_mbid, it.isrc, it.title_norm, it.score,
            it.components ? JSON.stringify(it.components) : null,
            p?.provider ?? null, p?.ext_id ?? null, p?.play_uri ?? null, p?.market ?? null, p ? 'cache' : null, p ? cutoff : null);
        }
      });
    }

    return {
      run_id: runId,
      mode,
      algo_version: ALGO_VERSION,
      items,
      unresolved: seeds.unresolved,
      params_hash: paramsHash,
      reason: items.length ? null : 'no candidates after filters',
    };
  } finally {
    if (ownTxn) db.exec('COMMIT');
  }
}

function resolveSeeds(db, seeds) {
  const resolved = [];
  const unresolved = [];
  const report = [];
  const byMbid = db.prepare(`SELECT id FROM artist WHERE mbid=?`);
  const byAlias = db.prepare(`SELECT DISTINCT artist_id, source FROM artist_alias WHERE alias_norm=?`);
  for (const s of seeds) {
    if (!s) continue;
    if (s.mbid || (typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s))) {
      const mbid = (s.mbid || s).toLowerCase();
      const row = byMbid.get(mbid);
      if (row) {
        const id = row.id;
        resolved.push({ artist_id: id, mbid, source: 'mbid' });
        report.push({ input: s, artist_id: id });
      } else {
        unresolved.push({ input: s, reason: 'not_found' });
      }
      continue;
    }
    const name = s.name || (typeof s === 'string' ? s : null);
    if (!name) {
      unresolved.push(s.uri
        ? { input: s, reason: 'uri_not_resolved', hint: 'dj-mcp should resolve Spotify artist URIs to a name before calling recommend().' }
        : { input: s, reason: 'invalid' });
      continue;
    }
    const norm = normalizeArtist(name);
    const hits = byAlias.all(norm);
    let roots = [...new Set(hits.map((h) => h.artist_id))];
    if (roots.length > 1) {
      // A catalog artist can share a name with one you have played; the played one is meant.
      const played = [...new Set(hits.filter((h) => h.source !== CATALOG).map((h) => h.artist_id))];
      if (played.length === 1) roots = played;
    }
    if (roots.length === 1) {
      resolved.push({ artist_id: roots[0], name, source: 'name' });
      report.push({ input: s, artist_id: roots[0] });
    } else {
      unresolved.push({ input: s, reason: roots.length ? 'ambiguous' : 'not_found' });
    }
  }
  return { resolved, unresolved, report };
}

function splitEras(db, cutoff, gapDays) {
  const plays = db.prepare(
    `SELECT played_at, artist_id, track_id FROM play
     WHERE canonical_play_id IS NULL AND ts_quality = 'ok' AND played_at < ? AND artist_id IS NOT NULL AND match_version IS NOT NULL
     ORDER BY played_at`,
  ).all(cutoff);
  if (plays.length === 0) return [];
  const gap = gapDays * DAY;
  const eras = [];
  let start = plays[0].played_at;
  let prev = plays[0].played_at;
  let bucket = [plays[0]];
  for (const p of plays.slice(1)) {
    if (p.played_at - prev >= gap) {
      eras.push({ start, end: prev, plays: bucket });
      start = p.played_at;
      bucket = [];
    }
    bucket.push(p);
    prev = p.played_at;
  }
  eras.push({ start, end: cutoff, plays: bucket });
  eras.forEach((e, i) => { e.index = i; e.n = e.plays.length; });
  return eras;
}

function eraTastes(db, eras, cutoff, params) {
  // A love does not belong to one era, so the artist credits are read once and applied to each.
  const loveByArtist = lovedArtistCounts(db, cutoff);
  return eras.map((e) => {
    const byArtist = new Map();
    for (const p of e.plays) {
      const aid = p.artist_id;
      if (!aid) continue;
      let rec = byArtist.get(aid);
      if (!rec) { rec = { days: new Set(), last: 0, plays: 0 }; byArtist.set(aid, rec); }
      rec.days.add(Math.floor(p.played_at / DAY));
      rec.last = Math.max(rec.last, p.played_at);
      rec.plays++;
    }
    for (const [aid, nLove] of loveByArtist) {
      let rec = byArtist.get(aid);
      if (!rec) { rec = { days: new Set(), last: e.end, plays: 0 }; byArtist.set(aid, rec); }
      rec.love = (rec.love || 0) + params.loveBonus * nLove;
    }
    const weights = new Map();
    let sum = 0;
    for (const [aid, rec] of byArtist) {
      const dt = Math.max(0, e.end - rec.last);
      const w = Math.log(1 + rec.days.size) * Math.exp(-dt / params.T) + (rec.love || 0);
      weights.set(aid, w);
      sum += w;
    }
    if (sum > 0) for (const [aid, w] of weights) weights.set(aid, w / sum);
    return { era: e, weights, n: e.n };
  });
}

function lovedArtistCounts(db, cutoff) {
  const counts = new Map();
  const loves = db.prepare(
    `SELECT track_id FROM lb_feedback WHERE score = 1 AND created < ? AND track_id IS NOT NULL`,
  ).all(cutoff);
  const artistsOf = db.prepare(`SELECT artist_id FROM track_artist WHERE track_id=?`);
  for (const l of loves) {
    for (const a of artistsOf.all(l.track_id)) {
      if (a.artist_id == null) continue;
      counts.set(a.artist_id, (counts.get(a.artist_id) || 0) + 1);
    }
  }
  return counts;
}

function eraWeights(tastes, params) {
  if (tastes.length === 0) return [];
  if (tastes.length === 1) return [1];
  const s = tastes.map((t) => t.n / (t.n + params.kappa));
  const latest = s[s.length - 1];
  const w = new Array(tastes.length);
  w[w.length - 1] = params.rho * latest;
  const rest = 1 - w[w.length - 1];
  const raw = tastes.slice(0, -1).map((t, i) => Math.log(1 + t.n) * s[i]);
  const rawSum = raw.reduce((a, b) => a + b, 0) || 1;
  raw.forEach((x, i) => { w[i] = rest * (x / rawSum); });
  return w;
}

// Int32Array id → dense index when every id is a non-negative safe integer and the
// table is modest. Huge or sparse ids (max id far above the edge count) use Map.
const DENSE_INDEX_CAP = 1 << 22; // 4,194,304 slots, 16 MiB
const DENSE_INDEX_ALWAYS = 1 << 20; // at or below this, always use the typed lookup
const DENSE_INDEX_PER_EDGE = 64;

function canDenseIndex(id) {
  return typeof id === 'number' && Number.isSafeInteger(id) && id >= 0;
}

// Weight stays in JS. SQLite yields NULL for 1/(rank+1) when rank is -1, while
// this is Infinity, and a large INTEGER rank can divide differently once it
// leaves SQLite. NULL raw and NULL rank stay weight 1; a present raw wins,
// including 0.
function edgeWeight(raw, rank) {
  return raw != null ? Number(raw) : (rank != null ? 1 / (Number(rank) + 1) : 1);
}

/**
 * Symmetrized, row-normalized artist graph as CSR.
 * Node index i is the i-th distinct artist id in the edge scan (src then dst).
 * col[k] is that dense index, not the artist id. P[k] is the normalized weight.
 * ids / idsByIndex keep first-seen order for the teleport and the result Map.
 */
export function loadGraph(db) {
  const stmt = db.prepare(`SELECT src, dst, raw, rank FROM edge`);
  stmt.setReturnArrays(true);
  const rows = stmt.all();
  const m = rows.length;
  if (m === 0) {
    return {
      ids: new Set(),
      idsByIndex: [],
      rowPtr: new Int32Array(1),
      col: new Int32Array(0),
      P: new Float64Array(0),
      indexOf: () => -1,
      indexKind: 'array',
    };
  }

  let arrayOk = true;
  let maxId = 0;
  for (let i = 0; i < m; i++) {
    const src = rows[i][0];
    const dst = rows[i][1];
    if (!canDenseIndex(src) || !canDenseIndex(dst)) { arrayOk = false; break; }
    if (src > maxId) maxId = src;
    if (dst > maxId) maxId = dst;
  }
  const cells = maxId + 1;
  const allowance = Math.max(DENSE_INDEX_ALWAYS, m * DENSE_INDEX_PER_EDGE);
  const useArray = arrayOk && cells <= DENSE_INDEX_CAP && cells <= allowance;
  // Slot 0 means "unseen"; a stored index is slot - 1. The array is zero-filled.
  const lookup = useArray ? new Int32Array(cells) : new Map();
  const indexKind = useArray ? 'array' : 'map';
  const ids = new Set();
  const idsByIndex = [];
  const assign = useArray
    ? (id) => {
        const slot = lookup[id];
        if (slot !== 0) return slot - 1;
        const i = idsByIndex.length;
        lookup[id] = i + 1;
        idsByIndex.push(id);
        ids.add(id);
        return i;
      }
    : (id) => {
        const at = lookup.get(id);
        if (at !== undefined) return at;
        const i = idsByIndex.length;
        lookup.set(id, i);
        idsByIndex.push(id);
        ids.add(id);
        return i;
      };

  // One undirected row becomes src→dst then dst→src, except a self-loop, which
  // only reserves the id. That is the old put() order.
  const srcIdx = new Int32Array(m * 2);
  const dstIdx = new Int32Array(m * 2);
  const dirW = new Float64Array(m * 2);
  let eCount = 0;
  for (let i = 0; i < m; i++) {
    const row = rows[i];
    const si = assign(row[0]);
    const di = assign(row[1]);
    if (si === di) continue;
    const w = edgeWeight(row[2], row[3]);
    srcIdx[eCount] = si;
    dstIdx[eCount] = di;
    dirW[eCount] = w;
    eCount++;
    srcIdx[eCount] = di;
    dstIdx[eCount] = si;
    dirW[eCount] = w;
    eCount++;
  }

  const n = idsByIndex.length;
  const counts = new Int32Array(n);
  for (let e = 0; e < eCount; e++) counts[srcIdx[e]]++;
  const groupPtr = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) groupPtr[i + 1] = groupPtr[i] + counts[i];
  // Forward scatter from the group heads is a stable counting sort, so each
  // row's neighbors stay in first-seen order.
  const cursor = groupPtr.slice();
  const colG = new Int32Array(eCount);
  const wG = new Float64Array(eCount);
  for (let e = 0; e < eCount; e++) {
    const pos = cursor[srcIdx[e]]++;
    colG[pos] = dstIdx[e];
    wG[pos] = dirW[e];
  }

  const seenStamp = new Int32Array(n);
  const seenAt = new Int32Array(n);
  let stamp = 1;
  const col = new Int32Array(eCount);
  const prob = new Float64Array(eCount);
  const rowPtr = new Int32Array(n + 1);
  let write = 0;
  for (let i = 0; i < n; i++) {
    const rowStart = write;
    const end = groupPtr[i + 1];
    for (let k = groupPtr[i]; k < end; k++) {
      const d = colG[k];
      const val = wG[k];
      if (seenStamp[d] !== stamp) {
        // First sight: max(0, weight). A later duplicate is max(current, weight).
        seenStamp[d] = stamp;
        seenAt[d] = write;
        col[write] = d;
        prob[write] = Math.max(0, val);
        write++;
      } else {
        const at = seenAt[d];
        prob[at] = Math.max(prob[at], val);
      }
    }
    stamp++;
    let s = 0;
    for (let k = rowStart; k < write; k++) s += prob[k];
    // Non-positive sum (all weights clamped to 0, or NaN) drops the row.
    // A positive sum keeps zero-probability neighbors.
    if (s > 0) {
      for (let k = rowStart; k < write; k++) prob[k] /= s;
    } else {
      write = rowStart;
    }
    rowPtr[i + 1] = write;
  }

  const indexOf = useArray
    ? (id) => {
        if (typeof id !== 'number' || !Number.isInteger(id) || id < 0 || id >= lookup.length) return -1;
        const slot = lookup[id];
        return slot === 0 ? -1 : slot - 1;
      }
    : (id) => {
        const at = lookup.get(id);
        return at === undefined ? -1 : at;
      };

  const nnz = write;
  return {
    ids,
    idsByIndex,
    rowPtr,
    col: nnz === eCount ? col : col.slice(0, nnz),
    P: nnz === eCount ? prob : prob.slice(0, nnz),
    indexOf,
    indexKind,
  };
}

function buildTeleport(tastes, seeds, graphIds, params) {
  const wEra = eraWeights(tastes, params);
  const v = new Map();
  const add = (id, x) => v.set(id, (v.get(id) || 0) + x);
  // v = γ v_seed + (1-γ) Σ w_e v_taste(e); γ=0 when no seeds
  const gamma = seeds.resolved.length ? 0.5 : 0;
  if (gamma < 1) {
    for (let i = 0; i < tastes.length; i++) {
      const we = (wEra[i] ?? 0) * (1 - gamma);
      for (const [aid, w] of tastes[i].weights) add(aid, we * w);
    }
  }
  if (gamma > 0 && seeds.resolved.length) {
    const u = 1 / seeds.resolved.length;
    for (const s of seeds.resolved) add(s.artist_id, gamma * u);
  }
  let sum = 0;
  for (const x of v.values()) sum += x;
  if (sum <= 0) {
    // uniform over graph ids or tastes
    const ids = graphIds.size ? [...graphIds] : [...new Set(tastes.flatMap((t) => [...t.weights.keys()]))];
    const u = ids.length ? 1 / ids.length : 1;
    for (const id of ids) v.set(id, u);
    return v;
  }
  for (const [id, x] of v) v.set(id, x / sum);
  return v;
}

/**
 * Personalized PageRank on the CSR graph.
 * Push order is dense index i ascending (first-seen id order). Teleport-only
 * keys of v, in v's order, follow the graph nodes and have an empty row.
 * Dangling mass is r[i] * (1 - outSum[i]), with outSum the sum of the stored
 * row, including zeros. The result Map uses that same key order.
 */
export function personalizedPageRank(graph, v, params) {
  const alpha = params.alpha;
  const idsByIndex = graph.idsByIndex;
  const nGraph = idsByIndex.length;
  const indexOf = graph.indexOf;
  const extras = [];
  for (const id of v.keys()) {
    if (indexOf(id) === -1) extras.push(id);
  }
  const n = nGraph + extras.length;
  if (n === 0) return new Map();

  const extraAt = new Map();
  for (let i = 0; i < extras.length; i++) extraAt.set(extras[i], nGraph + i);

  const r = new Float64Array(n);
  const vArr = new Float64Array(n);
  for (const [id, weight] of v) {
    const gi = indexOf(id);
    vArr[gi === -1 ? extraAt.get(id) : gi] = weight;
  }
  let vs = 0;
  for (let i = 0; i < n; i++) vs += vArr[i];
  if (vs <= 0) {
    for (let i = 0; i < n; i++) vArr[i] = 1 / n;
  } else {
    for (let i = 0; i < n; i++) vArr[i] /= vs || 1;
  }
  r.set(vArr);

  const rowPtr = graph.rowPtr;
  const col = graph.col;
  const prob = graph.P;
  const outSum = new Float64Array(n);
  for (let i = 0; i < nGraph; i++) {
    let s = 0;
    const end = rowPtr[i + 1];
    for (let k = rowPtr[i]; k < end; k++) s += prob[k];
    outSum[i] = s;
  }

  const next = new Float64Array(n);
  for (let it = 0; it < params.pprIterations; it++) {
    next.fill(0);
    let dang = 0;
    for (let i = 0; i < n; i++) dang += r[i] * (1 - outSum[i]);
    for (let i = 0; i < nGraph; i++) {
      const ri = r[i];
      const end = rowPtr[i + 1];
      for (let k = rowPtr[i]; k < end; k++) next[col[k]] += prob[k] * ri;
    }
    for (let j = 0; j < n; j++) {
      next[j] = (1 - alpha) * (next[j] + vArr[j] * dang) + alpha * vArr[j];
    }
    r.set(next);
  }

  const out = new Map();
  for (let i = 0; i < nGraph; i++) out.set(idsByIndex[i], r[i]);
  for (let i = 0; i < extras.length; i++) out.set(extras[i], r[nGraph + i]);
  return out;
}

function applyPopularity(db, rank, params) {
  const pops = db.prepare(`SELECT artist_id, user_count FROM artist_popularity WHERE source='lb'`).all();
  const pop = new Map();
  const vals = [];
  for (const p of pops) {
    const id = p.artist_id;
    if (id == null) continue;
    if (p.user_count != null) {
      pop.set(id, Number(p.user_count));
      vals.push(Number(p.user_count));
    }
  }
  vals.sort((a, b) => a - b);
  const q = (t) => vals.length ? vals[Math.min(vals.length - 1, Math.max(0, Math.floor(t * (vals.length - 1))))] : 0;
  const lo = q(params.popWinsorLow);
  const hi = q(params.popWinsorHigh) || lo || 1;
  const med = q(0.5) || 1;
  const out = new Map();
  for (const [id, r] of rank) {
    let p = pop.has(id) ? pop.get(id) : med;
    if (p < lo) p = lo;
    if (p > hi) p = hi;
    out.set(id, r / Math.pow(p + params.c, params.beta));
  }
  return out;
}

function heavyArtists(db, eras, params) {
  const map = new Map();
  for (const e of eras) {
    const counts = new Map();
    const days = new Map();
    for (const p of e.plays) {
      const aid = p.artist_id;
      if (!aid) continue;
      counts.set(aid, (counts.get(aid) || 0) + 1);
      if (!days.has(aid)) days.set(aid, new Set());
      days.get(aid).add(Math.floor(p.played_at / DAY));
    }
    const sorted = [...counts.values()].sort((a, b) => b - a);
    const cut = sorted[Math.max(0, Math.ceil(sorted.length * params.q / 100) - 1)] ?? Infinity;
    const set = new Set();
    for (const [id, c] of counts) {
      if (c >= cut && (days.get(id)?.size || 0) >= params.m) set.add(id);
    }
    map.set(e.index, set);
  }
  return map;
}

function playCounts(plays) {
  const counts = new Map();
  for (const p of plays) {
    if (p.artist_id == null) continue;
    counts.set(p.artist_id, (counts.get(p.artist_id) || 0) + 1);
  }
  return counts;
}

/**
 * Recordings for the ranked artists, at most topN per artist, from the artist's LB top recordings
 * that refresh registered as tracks.
 * discover: never a recording played before the cutoff, nor the same song (primary artist and
 * title_norm) under another recording.
 * rediscover: played recordings are the point; without top recordings, the artist's most played
 * tracks before the cutoff.
 *
 * `limit` is the number of items recommend() will keep (floor of 2*n). A later artist's best
 * recording scores at most that artist's score when the score is non-negative, and a tie sorts
 * after artists already visited, so once that many survivors sit at or above the next artist's
 * score the prefix and its pre_ranks are final.
 */
export function expandToRecordings(db, artistScores, {
  mode, topN, cutoff, limit = null, blockedTrack = null, blockedByMiss = null,
} = {}) {
  const discover = mode === 'discover';
  const played = discover ? playedBefore(db, cutoff) : null;
  const songStmt = discover ? db.prepare(SONG_KEY_SQL) : null;
  const songKeyOf = (trackId) => formatSongKey(songStmt.get(trackId));
  const artistMbid = db.prepare(`SELECT mbid FROM artist WHERE id=?`);
  const tops = db.prepare(`SELECT body FROM fetch_cache WHERE endpoint='lb:top-recordings' AND key=?`);
  const trackByMbid = db.prepare(`SELECT id FROM track WHERE mbid=?`);
  const ownTop = db.prepare(
    `SELECT track_id AS id, count(*) AS c FROM play
     WHERE canonical_play_id IS NULL AND ts_quality='ok' AND artist_id=? AND track_id IS NOT NULL AND match_version IS NOT NULL AND played_at < ?
     GROUP BY track_id ORDER BY c DESC, track_id LIMIT ?`,
  );
  const block = blockedTrack || (() => false);
  const miss = blockedByMiss || (() => false);
  const forArtist = (aid, aScore) => {
    const mbid = artistMbid.get(aid)?.mbid;
    let recs = topRows(mbid ? tops.get(mbid)?.body : null)
      .map((x, i) => ({ track_id: trackByMbid.get(x.recording_mbid)?.id, rank: i + 1, source: 'top-recordings' }))
      .filter((r) => r.track_id);
    if (discover) recs = recs.filter((r) => !played.tracks.has(r.track_id) && !played.songs.has(songKeyOf(r.track_id)));
    recs = recs.slice(0, topN);
    if (recs.length === 0 && !discover) {
      recs = ownTop.all(aid, cutoff, topN).map((r, i) => ({ track_id: r.id, rank: i + 1, source: 'own-plays' }));
    }
    return recs.map((rec) => ({
      artist_id: aid,
      track_id: rec.track_id,
      score: aScore * (1 / rec.rank),
      source: rec.source,
      components: { artist_score: aScore, rec_rank: rec.rank },
      rec_rank: rec.rank,
    }));
  };
  const rankedArtists = [...artistScores.entries()].sort((a, b) => b[1] - a[1]);
  const candidates = [];
  let kept = [];
  for (let i = 0; i < rankedArtists.length; i++) {
    const [aid, aScore] = rankedArtists[i];
    if (limit != null && kept.length >= limit && aScore >= 0 && aScore <= kept[limit - 1].score) break;
    const recs = forArtist(aid, aScore);
    candidates.push(...recs);
    if (limit == null) continue;
    if (recs.some((r) => !block(r.track_id) && !miss(r.track_id))) kept = takeDiverse(candidates, limit, block, miss);
  }
  candidates.sort((a, b) => b.score - a.score);
  candidates.forEach((it, i) => { it.pre_rank = i + 1; });
  return candidates;
}

// A recording credited to several artists can be a top recording of each. The higher score
// keeps the track; the later artist falls through to its next candidate. A hated, recently
// shown, or unresolved track does not use up the artist.
function takeDiverse(candidates, limit, blockedTrack, blockedByMiss) {
  const sorted = candidates.slice().sort((a, b) => b.score - a.score);
  const out = [];
  const seenArtist = new Set();
  const seenTrack = new Set();
  const block = blockedTrack || (() => false);
  const miss = blockedByMiss || (() => false);
  for (const it of sorted) {
    if (block(it.track_id)) continue;
    if (seenArtist.has(it.artist_id) || seenTrack.has(it.track_id)) continue;
    if (miss(it.track_id)) continue;
    seenArtist.add(it.artist_id);
    seenTrack.add(it.track_id);
    out.push(it);
    if (limit != null && out.length >= limit) break;
  }
  return out;
}

function topRows(body) {
  if (!body) return [];
  try {
    const arr = JSON.parse(body);
    return Array.isArray(arr) ? arr.slice(0, TOP_RECORDINGS_KEPT) : [];
  } catch {
    return [];
  }
}

const SONG_KEY_SQL = `SELECT t.title_norm, ta.artist_id FROM track t LEFT JOIN track_artist ta ON ta.track_id = t.id AND ta.position = 0 WHERE t.id=?`;

function formatSongKey(r) {
  return `${r?.artist_id ?? ''}\u0000${r?.title_norm ?? ''}`;
}

export function songKey(db, trackId) {
  return formatSongKey(db.prepare(SONG_KEY_SQL).get(trackId));
}

export function playedBefore(db, cutoff) {
  const rows = db.prepare(
    `SELECT p.track_id AS track_id, t.title_norm AS title_norm, ta.artist_id AS artist_id
     FROM (SELECT DISTINCT track_id FROM play WHERE track_id IS NOT NULL AND match_version IS NOT NULL AND played_at < ?) p
     LEFT JOIN track t ON t.id = p.track_id
     LEFT JOIN track_artist ta ON ta.track_id = t.id AND ta.position = 0`,
  ).all(cutoff);
  const tracks = new Set();
  const songs = new Set();
  for (const r of rows) {
    tracks.add(r.track_id);
    songs.add(formatSongKey(r));
  }
  return { tracks, songs };
}

function summarizeEras(eras) {
  return eras.map((e) => ({ index: e.index, start: e.start, end: e.end, n: e.n }));
}

