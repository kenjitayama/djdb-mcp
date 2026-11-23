import { createHash } from 'node:crypto';
import { getMeta } from './db.mjs';
import { canon, canonOrNull, identity } from './canon.mjs';
import { normalizeArtist } from './normalize.mjs';
import { bindCheck, epochCheck, cachedId, activeMiss, readHighWatermarks, recentExposedTrackIds } from './online.mjs';
import { openSnapshotForRead, snapshotIdEpoch, snapshotOk } from './snapshot.mjs';
import { resolveSnapshotPath } from './paths.mjs';
import { openSnap } from './db.mjs';
import { DjdbError } from './errors.mjs';
import { createListenBrainzClient } from './listenbrainz.mjs';

export const ALGO_VERSION = 'v11';
export const DEFAULT_PARAMS = {
  alpha: 0.4,          // teleport; design range 0.3–0.5
  beta: 0.5,           // popularity exponent in r/(pop+c)^β
  rho: 0.6,            // latest-era share (times s_latest)
  kappa: 10,           // era strength n/(n+κ)
  T: 365 * 86400,      // recency decay (seconds)
  q: 20,               // heavy: top q% of play counts in an era
  m: 3,                // heavy: at least m distinct days in that era
  c: 1,                // popularity additive constant
  rrfK: 60,
  topN: 3,             // top recordings per artist
  overlayDays: 30,
  eraGapDays: 180,
  pprIterations: 50,
  popWinsorLow: 0.05,
  popWinsorHigh: 0.95,
  loveBonus: 1,
};

const DAY = 86400;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6D2B79F5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(s) {
  if (typeof s === 'number' && Number.isFinite(s)) return s >>> 0;
  const h = createHash('sha256').update(String(s ?? '0')).digest();
  return h.readUInt32LE(0);
}

/**
 * recommend({ mode, n, provider, market, randomSeed, seeds, record })
 * Ranking uses the snapshot only (plays, graph, popularity, lb_feedback).
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

  const bind = bindCheck(handle.online, handle.main);
  if (!bind.ok) {
    return { items: [], disabled: true, reason: bind.reason, hint: bind.hint };
  }
  epochCheck(handle.online, handle.main);

  const liveEpoch = getMeta(handle.main, 'id_epoch');
  const onlineEpoch = getMeta(handle.online, 'id_epoch');
  const picked = pickSnapshot(handle, liveEpoch, onlineEpoch);
  if (!picked) {
    return { items: [], reason: 'no snapshot: run djdb refresh' };
  }
  const snap = picked.d;
  try {
    const seeds = resolveSeeds(snap, opts.seeds || []);
    const eras = splitEras(snap, cutoff, params.eraGapDays);
    const tastes = eraTastes(snap, eras, cutoff, params);
    const graph = loadGraph(snap);
    const v = buildTeleport(tastes, seeds, graph.ids, params);
    const rank = personalizedPageRank(graph, v, params);
    const popAdj = applyPopularity(snap, rank, params);
    const heavy = heavyArtists(snap, eras, params);
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
      eligible = [...popAdj.entries()].filter(([id]) => oldHeavy.has(id) && !latestHeavy.has(id) && almostSilent(snap, id, latest));
    }

    const hated = new Set(
      snap.prepare(`SELECT track_id FROM lb_feedback WHERE score = -1 AND track_id IS NOT NULL`).all()
        .map((r) => canonOrNull(snap, 'track', r.track_id))
        .filter(Boolean),
    );

    const artistScores = new Map(eligible);
    const expanded = expandToRecordings(snap, artistScores, params.topN);
    const radio = record || opts.fetchRadio
      ? await fetchRadio(handle, snap, opts, seeds.resolved, tastes, params, cutoff)
      : { items: [], prompt: null, skipped: !record };

    const mixed = rrfMerge(expanded, radio.items, params.rrfK);
    mixed.forEach((it) => {
      it.track_id = canonOrNull(snap, 'track', it.track_id) ?? it.track_id;
      it.artist_id = canonOrNull(snap, 'artist', it.artist_id) ?? it.artist_id;
    });

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
    for (const it of mixed) {
      if (hated.has(it.track_id)) continue;
      if (recentSet.has(it.track_id) && !opts.eval) continue;
      if (seenArtist.has(it.artist_id)) continue;
      if (!opts.eval && handle.online && !cachedId(handle.online, snap, it.track_id, provider)
          && activeMiss(handle.online, snap, it.track_id, provider, market, cutoff)) continue;
      seenArtist.add(it.artist_id);
      filtered.push(it);
    }

    if (filtered.length === 0 && mode === 'discover') {
      const nCache = snap.prepare(`SELECT count(*) AS n FROM fetch_cache WHERE endpoint='lb:top-recordings'`).get().n;
      const reason = nCache === 0
        ? 'no top-recordings cache and LB popularity looks paused; try djdb refresh later'
        : 'no candidates after filters';
      return { items: [], reason, mode, seeds: seeds.report, eras: summarizeEras(eras), unresolved: seeds.unresolved };
    }

    const take = filtered.slice(0, n * 2);
    const items = take.map((it, i) => {
      const idn = identity(snap, it.track_id) || { mbid: null, isrcs: [], title_norm: '' };
      const tr = snap.prepare(`SELECT title, artist_credit FROM track WHERE id=?`).get(it.track_id);
      const cache = handle.online && !opts.eval ? cachedId(handle.online, snap, it.track_id, provider) : null;
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
      radio_prompt: radio.prompt,
      prior_rec_run_max_id: hwm.prior_rec_run_max_id,
      rec_event_max_id: hwm.rec_event_max_id,
      snapshot_id: picked.id,
      snapshot_sha256: picked.sha256,
    };
    const paramsHash = createHash('sha256').update(JSON.stringify(paramsJson)).digest('hex');

    let runId = null;
    if (record && handle.online && !opts.eval) {
      const ins = handle.online.prepare(
        `INSERT INTO rec_run (created_at, snapshot_id, snapshot_sha256, mode, algo_version, params_hash, params_json, fetched_json)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(cutoff, picked.id, picked.sha256, mode, ALGO_VERSION, paramsHash, JSON.stringify(paramsJson), radio.raw ? JSON.stringify(radio.raw) : null);
      runId = Number(ins.lastInsertRowid);
      const add = handle.online.prepare(
        `INSERT INTO rec_item (run_id, rank, pre_rank, candidate_source, artist_id, track_id, recording_mbid, isrc, title_norm, score, components_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      );
      const playable = handle.online.prepare(
        `INSERT INTO rec_item_playable (run_id, rank, provider, ext_id, play_uri, market, resolved_by, resolved_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      );
      for (const it of items) {
        add.run(runId, it.rank, it.pre_rank, it.candidate_source, it.artist_id, it.track_id, it.recording_mbid, it.isrc, it.title_norm, it.score, it.components ? JSON.stringify(it.components) : null);
        if (it.playable) {
          playable.run(runId, it.rank, it.playable.provider, it.playable.ext_id, it.playable.play_uri ?? null, it.playable.market, 'cache', cutoff);
        }
      }
    }

    return {
      run_id: runId,
      mode,
      algo_version: ALGO_VERSION,
      snapshot_id: picked.id,
      items,
      unresolved: seeds.unresolved,
      params_hash: paramsHash,
      reason: items.length ? null : 'no candidates after filters',
    };
  } finally {
    try { snap.close(); } catch {}
  }
}

function pickSnapshot(handle, liveEpoch, onlineEpoch) {
  // Prefer a snapshot whose id_epoch matches the live / online epoch (implementation memo).
  // Scan newest-first; skip snapshots whose epoch does not match after an online/live sync.
  const want = onlineEpoch || liveEpoch;
  // Re-scan manually so we can skip epoch mismatches rather than taking the first valid file.
  const rows = handle.main.prepare(`SELECT id, path, sha256 FROM snapshot ORDER BY id DESC`).all();
  for (const r of rows) {
    const got = openSnapshotForReadOne(handle, r);
    if (!got) continue;
    const ep = snapshotIdEpoch(got.d);
    if (want && ep && ep !== want) {
      got.d.close();
      continue;
    }
    return got;
  }
  return null;
}

function openSnapshotForReadOne(handle, r) {
  try {
    if (!snapshotOk(handle.paths.snapsDir, r)) return null;
    const abs = resolveSnapshotPath(handle.paths.snapsDir, r.path);
    return { ...r, abs, d: openSnap(abs) };
  } catch {
    return null;
  }
}

function resolveSeeds(snap, seeds) {
  const resolved = [];
  const unresolved = [];
  const report = [];
  for (const s of seeds) {
    if (!s) continue;
    if (s.mbid || (typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s))) {
      const mbid = (s.mbid || s).toLowerCase();
      const row = snap.prepare(`SELECT id FROM artist WHERE mbid=?`).get(mbid);
      if (row) {
        const id = canon(snap, 'artist', row.id);
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
    const hits = snap.prepare(`SELECT DISTINCT artist_id FROM artist_alias WHERE alias_norm=?`).all(norm);
    const roots = [...new Set(hits.map((h) => canon(snap, 'artist', h.artist_id)))];
    if (roots.length === 1) {
      resolved.push({ artist_id: roots[0], name, source: 'name' });
      report.push({ input: s, artist_id: roots[0] });
    } else {
      unresolved.push({ input: s, reason: roots.length ? 'ambiguous' : 'not_found' });
    }
  }
  return { resolved, unresolved, report };
}

function splitEras(snap, cutoff, gapDays) {
  const plays = snap.prepare(
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

function eraTastes(snap, eras, cutoff, params) {
  return eras.map((e) => {
    const byArtist = new Map();
    for (const p of e.plays) {
      const aid = canonOrNull(snap, 'artist', p.artist_id);
      if (!aid) continue;
      let rec = byArtist.get(aid);
      if (!rec) { rec = { days: new Set(), last: 0, plays: 0 }; byArtist.set(aid, rec); }
      rec.days.add(Math.floor(p.played_at / DAY));
      rec.last = Math.max(rec.last, p.played_at);
      rec.plays++;
    }
    const loves = snap.prepare(
      `SELECT track_id FROM lb_feedback WHERE score = 1 AND created < ? AND track_id IS NOT NULL`,
    ).all(cutoff);
    for (const l of loves) {
      const tid = canonOrNull(snap, 'track', l.track_id);
      if (!tid) continue;
      const aids = snap.prepare(`SELECT artist_id FROM track_artist WHERE track_id=?`).all(tid);
      for (const a of aids) {
        const aid = canonOrNull(snap, 'artist', a.artist_id);
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

function loadGraph(snap) {
  const edges = snap.prepare(`SELECT src, dst, raw, rank FROM edge`).all();
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
  for (let i = 0; i < tastes.length; i++) {
    const we = wEra[i] ?? 0;
    for (const [aid, w] of tastes[i].weights) add(aid, (1 - (seeds.resolved.length ? 0 : 0)) /* placeholder */);
    // v = γ v_seed + (1-γ) Σ w_e v_taste(e); γ=0 when no seeds
  }
  // rebuild properly
  v.clear();
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

function applyPopularity(snap, rank, params) {
  const pops = snap.prepare(`SELECT artist_id, user_count FROM artist_popularity WHERE source='lb'`).all();
  const pop = new Map();
  const vals = [];
  for (const p of pops) {
    const id = canonOrNull(snap, 'artist', p.artist_id);
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

function heavyArtists(snap, eras, params) {
  const map = new Map();
  for (const e of eras) {
    const counts = new Map();
    const days = new Map();
    for (const p of e.plays) {
      const aid = canonOrNull(snap, 'artist', p.artist_id);
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

function almostSilent(snap, artistId, latest) {
  if (!latest) return true;
  const n = latest.plays.filter((p) => p.artist_id === artistId).length;
  return n <= 1;
}

function expandToRecordings(snap, artistScores, topN) {
  const rankedArtists = [...artistScores.entries()].sort((a, b) => b[1] - a[1]);
  const out = [];
  for (const [aid, aScore] of rankedArtists) {
    const artist = snap.prepare(`SELECT mbid FROM artist WHERE id=?`).get(aid);
    let recs = [];
    if (artist?.mbid) {
      const hit = snap.prepare(`SELECT body FROM fetch_cache WHERE endpoint='lb:top-recordings' AND key=?`).get(artist.mbid);
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
      recs = snap.prepare(
        `SELECT track_id AS id, count(*) AS c FROM play
         WHERE canonical_play_id IS NULL AND ts_quality='ok' AND artist_id=? AND track_id IS NOT NULL
         GROUP BY track_id ORDER BY c DESC LIMIT ?`,
      ).all(aid, topN).map((r, i) => ({ track_id: r.id, rank: i + 1 }));
    }
    recs.forEach((rec, i) => {
      let tid = rec.track_id;
      if (!tid && rec.mbid) {
        tid = snap.prepare(`SELECT id FROM track WHERE mbid=?`).get(rec.mbid)?.id;
        if (!tid && rec.title) {
          // create-less: skip unknown catalog recordings? keep as synthetic via title lookup
          tid = snap.prepare(
            `SELECT t.id FROM track t JOIN track_artist ta ON ta.track_id=t.id AND ta.position=0
             WHERE ta.artist_id=? AND t.title_norm=(SELECT title_norm FROM track WHERE id=t.id) LIMIT 1`,
          ).get(aid)?.id;
        }
      }
      if (!tid && rec.mbid) {
        // Not in the library: still recommend the catalog recording using a shadow id of 0? Better skip library-only expand
        // Keep as mbid-only candidate with artist_id, track_id looked up or omitted.
        // rec_item.track_id is NOT NULL, so we only include tracks present in the snapshot.
        return;
      }
      if (!tid) return;
      tid = canonOrNull(snap, 'track', tid);
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

function rrfMerge(expanded, radioItems, k) {
  const map = new Map();
  const add = (key, item, rank, source) => {
    const cur = map.get(key) || { ...item, rrf: 0, sources: [] };
    cur.rrf += 1 / (k + rank);
    cur.sources.push(source);
    cur.artist_id = cur.artist_id || item.artist_id;
    cur.track_id = cur.track_id || item.track_id;
    map.set(key, cur);
  };
  expanded.forEach((it, i) => add(`t:${it.track_id}`, it, i + 1, 'expand'));
  radioItems.forEach((it, i) => {
    const key = it.track_id ? `t:${it.track_id}` : `m:${it.recording_mbid}`;
    add(key, it, i + 1, 'radio');
  });
  return [...map.values()].map((it) => ({ ...it, score: it.rrf, source: it.sources.join('+') }))
    .sort((a, b) => b.score - a.score);
}

async function fetchRadio(handle, snap, opts, resolvedSeeds, tastes, params, cutoff) {
  if (opts.skipRadio) return { items: [], prompt: null };
  const client = opts.client || (opts.fetch ? createListenBrainzClient({ fetch: opts.fetch, token: opts.token }) : null);
  if (!client?.lbRadioArtist) return { items: [], prompt: null, skipped: true };
  let seeds = resolvedSeeds.slice(0, 3).map((s) => ({ ...s, mbid: s.mbid || snap.prepare('SELECT mbid FROM artist WHERE id=?').get(s.artist_id)?.mbid || null }));
  if (seeds.length === 0) {
    const top = [...(tastes.at(-1)?.weights || new Map()).entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    const rng = mulberry32(hashSeed(opts.randomSeed ?? cutoff));
    seeds = weightedSample(top, 3, rng).map(([id, w]) => ({
      artist_id: id,
      weight: w,
      mbid: snap.prepare('SELECT mbid FROM artist WHERE id=?').get(id)?.mbid || null,
    }));
  }
  const prompt = [];
  const items = [];
  const raw = {};
  for (const s of seeds) {
    if (!s.mbid) continue;
    prompt.push(s.mbid);
    try {
      const body = await client.lbRadioArtist(s.mbid, { mode: 'easy' });
      raw[s.mbid] = body;
      const recs = flattenRadio(body);
      recs.forEach((r, i) => {
        const tid = r.recording_mbid ? snap.prepare('SELECT id FROM track WHERE mbid=?').get(r.recording_mbid)?.id : null;
        items.push({ recording_mbid: r.recording_mbid, artist_id: s.artist_id, track_id: tid ?? null, score: 0, source: 'radio', rec_rank: i + 1 });
      });
    } catch {
      // radio paused: one-sided RRF is fine
    }
  }
  return { items: items.filter((it) => it.track_id != null), prompt, raw: Object.keys(raw).length ? raw : null };
}

function flattenRadio(body) {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  const out = [];
  if (typeof body === 'object') {
    for (const v of Object.values(body)) {
      if (Array.isArray(v)) out.push(...v);
    }
  }
  return out;
}

function weightedSample(pairs, k, rng) {
  const pool = pairs.slice();
  const out = [];
  for (let n = 0; n < k && pool.length; n++) {
    const sum = pool.reduce((a, [, w]) => a + w, 0) || pool.length;
    let r = rng() * sum;
    let i = 0;
    for (; i < pool.length; i++) {
      r -= pool[i][1] || 0;
      if (r <= 0) break;
    }
    i = Math.min(i, pool.length - 1);
    out.push(pool.splice(i, 1)[0]);
  }
  return out;
}

function summarizeEras(eras) {
  return eras.map((e) => ({ index: e.index, start: e.start, end: e.end, n: e.n }));
}

export const _internal = { splitEras, personalizedPageRank, rrfMerge, mulberry32, eraWeights, DEFAULT_PARAMS };
