import { createHash } from 'node:crypto';
import { normalizeArtist } from './normalize.mjs';
import { bindCheck, cachedId, activeMiss, readHighWatermarks, recentExposedTrackIds, identity } from './online.mjs';
import { DjdbError } from './errors.mjs';

export const ALGO_VERSION = 'v11';
/**
 * 暫定 / provisional defaults, to be tuned after evaluation.
 * The v11 design fixes roles and some values (alpha 0.3–0.5, top 3
 * recordings, 180-day era gap, 30-day overlay/miss) but not exact values for
 * every knob. Do not treat these as final.
 */
export const DEFAULT_PARAMS = {
  alpha: 0.4,          // 暫定 / provisional. teleport; design range 0.3–0.5
  beta: 0.5,           // 暫定 / provisional. popularity exponent in r/(pop+c)^β
  rho: 0.6,            // 暫定 / provisional. latest-era share (times s_latest)
  kappa: 10,           // 暫定 / provisional. era strength n/(n+κ)
  T: 365 * 86400,      // 暫定 / provisional. recency decay (seconds)
  q: 20,               // 暫定 / provisional. heavy: top q% of play counts in an era
  m: 3,                // 暫定 / provisional. heavy: at least m distinct days in that era
  c: 1,                // 暫定 / provisional. popularity additive constant
  topN: 3,             // specified by the design
  overlayDays: 30,     // specified by the design
  eraGapDays: 180,     // specified by the design
  pprIterations: 50,   // 暫定 / provisional
  popWinsorLow: 0.05,  // 暫定 / provisional
  popWinsorHigh: 0.95, // 暫定 / provisional
  loveBonus: 1,        // 暫定 / provisional
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
      eligible = [...popAdj.entries()].filter(([id]) => oldHeavy.has(id) && !latestHeavy.has(id) && almostSilent(db, id, latest));
    }

    const hated = new Set(
      db.prepare(`SELECT track_id FROM lb_feedback WHERE score = -1 AND track_id IS NOT NULL`).all()
        .map((r) => r.track_id)
        .filter(Boolean),
    );

    const candidates = expandToRecordings(db, new Map(eligible), params.topN);

    // overlay HWMs (only when recording / when online is writable)
    let hwm = { prior_rec_run_max_id: 0, rec_event_max_id: 0 };
    let recent = [];
    if (handle.online && !opts.eval) {
      hwm = readHighWatermarks(handle.online);
      recent = recentExposedTrackIds(handle.online, hwm, { since: cutoff - params.overlayDays * DAY });
    }
    const recentSet = new Set(recent);

    const filtered = [];
    const seenArtist = new Set();
    for (const it of candidates) {
      if (hated.has(it.track_id)) continue;
      if (recentSet.has(it.track_id) && !opts.eval) continue;
      if (seenArtist.has(it.artist_id)) continue;
      if (!opts.eval && handle.online && !cachedId(handle.online, db, it.track_id, provider)
          && activeMiss(handle.online, db, it.track_id, provider, market, cutoff)) continue;
      seenArtist.add(it.artist_id);
      filtered.push(it);
    }

    if (filtered.length === 0 && mode === 'discover') {
      const nCache = db.prepare(`SELECT count(*) AS n FROM fetch_cache WHERE endpoint='lb:top-recordings'`).get().n;
      const reason = nCache === 0
        ? 'no top-recordings cache and LB popularity looks paused; try djdb refresh later'
        : 'no candidates after filters';
      return { items: [], reason, mode, seeds: seeds.report, eras: summarizeEras(eras), unresolved: seeds.unresolved };
    }

    const take = filtered.slice(0, n * 2);
    const items = take.map((it, i) => {
      const idn = identity(db, it.track_id) || { mbid: null, isrcs: [], title_norm: '' };
      const tr = db.prepare(`SELECT title, artist_credit FROM track WHERE id=?`).get(it.track_id);
      const cache = handle.online && !opts.eval ? cachedId(handle.online, db, it.track_id, provider) : null;
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
  for (const s of seeds) {
    if (!s) continue;
    if (s.mbid || (typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s))) {
      const mbid = (s.mbid || s).toLowerCase();
      const row = db.prepare(`SELECT id FROM artist WHERE mbid=?`).get(mbid);
      if (row) {
        const id = row.id;
        resolved.push({ artist_id: id, mbid, source: 'mbid' });
        report.push({ input: s, artist_id: id });
      } else {
        unresolved.push({ input: s, reason: 'not_found' });
      }
      continue;
    }
    if (s.uri) {
      unresolved.push({ input: s, reason: 'uri_not_resolved', hint: 'dj-mcp should resolve Spotify artist URIs to a name before calling recommend().' });
      continue;
    }
    const name = s.name || (typeof s === 'string' ? s : null);
    if (!name) {
      unresolved.push({ input: s, reason: 'invalid' });
      continue;
    }
    const norm = normalizeArtist(name);
    const hits = db.prepare(`SELECT DISTINCT artist_id FROM artist_alias WHERE alias_norm=?`).all(norm);
    const roots = [...new Set(hits.map((h) => h.artist_id))];
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
     WHERE canonical_play_id IS NULL AND ts_quality = 'ok' AND played_at < ? AND artist_id IS NOT NULL
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
    const loves = db.prepare(
      `SELECT track_id FROM lb_feedback WHERE score = 1 AND created < ? AND track_id IS NOT NULL`,
    ).all(cutoff);
    for (const l of loves) {
      const tid = l.track_id;
      if (!tid) continue;
      const aids = db.prepare(`SELECT artist_id FROM track_artist WHERE track_id=?`).all(tid);
      for (const a of aids) {
        const aid = a.artist_id;
        if (!aid) continue;
        let rec = byArtist.get(aid);
        if (!rec) { rec = { days: new Set(), last: e.end, plays: 0 }; byArtist.set(aid, rec); }
        rec.love = (rec.love || 0) + params.loveBonus;
      }
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

function loadGraph(db) {
  const edges = db.prepare(`SELECT src, dst, raw, rank FROM edge`).all();
  const ids = new Set();
  const w = new Map(); // src -> dst -> weight
  const put = (src, dst, val) => {
    ids.add(src); ids.add(dst);
    if (src === dst) return;
    if (!w.has(src)) w.set(src, new Map());
    const cur = w.get(src).get(dst) ?? 0;
    w.get(src).set(dst, Math.max(cur, val));
  };
  for (const e of edges) {
    const val = e.raw != null ? Number(e.raw) : (e.rank != null ? 1 / (Number(e.rank) + 1) : 1);
    put(e.src, e.dst, val);
    put(e.dst, e.src, val); // symmetrize with max
  }
  // row-normalize
  const P = new Map();
  for (const [src, dsts] of w) {
    let s = 0;
    for (const v of dsts.values()) s += v;
    const row = new Map();
    if (s > 0) for (const [d, v] of dsts) row.set(d, v / s);
    P.set(src, row);
  }
  // include isolated artists later via teleport
  return { P, ids, w };
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

function personalizedPageRank(graph, v, params) {
  const alpha = params.alpha;
  const ids = new Set([...graph.ids, ...v.keys()]);
  const list = [...ids];
  const idx = new Map(list.map((id, i) => [id, i]));
  const n = list.length;
  if (n === 0) return new Map();
  const r = new Float64Array(n);
  const vArr = new Float64Array(n);
  for (const [id, w] of v) if (idx.has(id)) vArr[idx.get(id)] = w;
  let vs = 0;
  for (const x of vArr) vs += x;
  if (vs <= 0) for (let i = 0; i < n; i++) vArr[i] = 1 / n;
  else for (let i = 0; i < n; i++) vArr[i] /= vs || 1;
  r.set(vArr);

  // dangling mass: 1 - Σ_j P_ij  (0 if isolated, since P row missing or empty)
  const outSum = new Float64Array(n);
  const adj = [];
  for (let i = 0; i < n; i++) {
    const row = graph.P.get(list[i]);
    const listRow = [];
    let s = 0;
    if (row) for (const [d, p] of row) {
      if (!idx.has(d)) continue;
      listRow.push([idx.get(d), p]);
      s += p;
    }
    outSum[i] = s;
    adj.push(listRow);
  }

  const next = new Float64Array(n);
  for (let it = 0; it < params.pprIterations; it++) {
    next.fill(0);
    let dang = 0;
    for (let i = 0; i < n; i++) dang += r[i] * (1 - outSum[i]);
    for (let i = 0; i < n; i++) {
      for (const [j, p] of adj[i]) next[j] += p * r[i];
    }
    for (let j = 0; j < n; j++) {
      next[j] = (1 - alpha) * (next[j] + vArr[j] * dang) + alpha * vArr[j];
    }
    r.set(next);
  }
  const out = new Map();
  for (let i = 0; i < n; i++) out.set(list[i], r[i]);
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

function almostSilent(db, artistId, latest) {
  if (!latest) return true;
  const n = latest.plays.filter((p) => p.artist_id === artistId).length;
  return n <= 1;
}

function expandToRecordings(db, artistScores, topN) {
  const rankedArtists = [...artistScores.entries()].sort((a, b) => b[1] - a[1]);
  const out = [];
  for (const [aid, aScore] of rankedArtists) {
    const artist = db.prepare(`SELECT mbid FROM artist WHERE id=?`).get(aid);
    let recs = [];
    if (artist?.mbid) {
      const hit = db.prepare(`SELECT body FROM fetch_cache WHERE endpoint='lb:top-recordings' AND key=?`).get(artist.mbid);
      if (hit?.body) {
        try {
          const body = JSON.parse(hit.body);
          const arr = Array.isArray(body) ? body : [];
          recs = arr.slice(0, topN).map((x, i) => ({
            mbid: x.recording_mbid,
            title: x.recording_name || x.title,
            rank: i + 1,
          }));
        } catch {}
      }
    }
    if (recs.length === 0) {
      recs = db.prepare(
        `SELECT track_id AS id, count(*) AS c FROM play
         WHERE canonical_play_id IS NULL AND ts_quality='ok' AND artist_id=? AND track_id IS NOT NULL
         GROUP BY track_id ORDER BY c DESC LIMIT ?`,
      ).all(aid, topN).map((r, i) => ({ track_id: r.id, rank: i + 1 }));
    }
    recs.forEach((rec, i) => {
      let tid = rec.track_id;
      if (!tid && rec.mbid) {
        tid = db.prepare(`SELECT id FROM track WHERE mbid=?`).get(rec.mbid)?.id;
        if (!tid && rec.title) {
          // create-less: skip unknown catalog recordings? keep as synthetic via title lookup
          tid = db.prepare(
            `SELECT t.id FROM track t JOIN track_artist ta ON ta.track_id=t.id AND ta.position=0
             WHERE ta.artist_id=? AND t.title_norm=(SELECT title_norm FROM track WHERE id=t.id) LIMIT 1`,
          ).get(aid)?.id;
        }
      }
      if (!tid && rec.mbid) {
        // Not in the library: still recommend the catalog recording using a shadow id of 0? Better skip library-only expand
        // Keep as mbid-only candidate with artist_id, track_id looked up or omitted.
        // rec_item.track_id is NOT NULL, so we only include tracks present in the main DB.
        return;
      }
      if (!tid) return;
      tid = tid;
      if (!tid) return;
      out.push({
        artist_id: aid,
        track_id: tid,
        score: aScore * (1 / rec.rank),
        source: rec.mbid ? 'top-recordings' : 'own-plays',
        pre_rank: out.length + 1,
        components: { artist_score: aScore, rec_rank: rec.rank },
        rec_rank: rec.rank,
      });
    });
  }
  out.sort((a, b) => b.score - a.score);
  out.forEach((it, i) => { it.pre_rank = i + 1; });
  return out;
}

function summarizeEras(eras) {
  return eras.map((e) => ({ index: e.index, start: e.start, end: e.end, n: e.n }));
}

