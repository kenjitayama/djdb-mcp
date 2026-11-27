// Bit-exact equivalence of the CSR loadGraph / personalizedPageRank with the
// previous Map-of-Maps implementation. The reference below is that old code.
// Made-up edges only; nothing here reads a real library.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initMainSchema } from '../lib/db.mjs';
import { loadGraph, personalizedPageRank } from '../lib/recommend.mjs';

function loadGraphRef(db) {
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

function personalizedPageRankRef(graph, v, params) {
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

function memoryEdges(rows) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE edge (src INTEGER, dst INTEGER, raw REAL, rank INTEGER)`);
  const ins = db.prepare(`INSERT INTO edge (src, dst, raw, rank) VALUES (?, ?, ?, ?)`);
  for (const r of rows) ins.run(r.src, r.dst, r.raw === undefined ? null : r.raw, r.rank === undefined ? null : r.rank);
  return db;
}

function rowOf(graph, id) {
  const i = graph.indexOf(id);
  assert.ok(i >= 0, `missing id ${id}`);
  const out = [];
  for (let k = graph.rowPtr[i]; k < graph.rowPtr[i + 1]; k++) {
    out.push([graph.idsByIndex[graph.col[k]], graph.P[k]]);
  }
  return out;
}

function assertRowsMatch(graph, ref) {
  assert.ok(graph.rowPtr instanceof Int32Array);
  assert.ok(graph.col instanceof Int32Array);
  assert.ok(graph.P instanceof Float64Array);
  assert.equal(graph.w, undefined);
  assert.equal(graph.rowPtr.length, graph.idsByIndex.length + 1);
  assert.equal(graph.rowPtr[0], 0);
  assert.equal(graph.rowPtr[graph.idsByIndex.length], graph.col.length);
  assert.equal(graph.col.length, graph.P.length);
  let prev = 0;
  for (let i = 1; i < graph.rowPtr.length; i++) {
    assert.ok(graph.rowPtr[i] >= prev);
    prev = graph.rowPtr[i];
  }
  for (let k = 0; k < graph.col.length; k++) {
    assert.ok(graph.col[k] >= 0 && graph.col[k] < graph.idsByIndex.length);
  }
  assert.deepStrictEqual(graph.idsByIndex, [...ref.ids]);
  assert.deepStrictEqual([...graph.ids], graph.idsByIndex);
  for (let i = 0; i < graph.idsByIndex.length; i++) {
    const id = graph.idsByIndex[i];
    assert.equal(graph.indexOf(id), i);
    const got = rowOf(graph, id);
    const wantRow = ref.P.get(id);
    const want = wantRow ? [...wantRow.entries()] : [];
    assert.equal(got.length, want.length, `degree of ${id}`);
    for (let k = 0; k < want.length; k++) {
      assert.ok(Object.is(got[k][0], want[k][0]), `neighbor ${id}[${k}]`);
      assert.ok(Object.is(got[k][1], want[k][1]), `P ${id}->${want[k][0]} ${got[k][1]} vs ${want[k][1]}`);
    }
  }
  assert.equal(graph.indexOf('missing'), -1);
}

function assertRanks(actual, expected) {
  const ak = [...actual.keys()];
  const ek = [...expected.keys()];
  assert.equal(ak.length, ek.length, `map size ${ak.length} vs ${ek.length}`);
  for (let i = 0; i < ek.length; i++) {
    assert.ok(Object.is(ak[i], ek[i]), `key[${i}] ${ak[i]} vs ${ek[i]}`);
    const a = actual.get(ak[i]);
    const e = expected.get(ek[i]);
    assert.ok(Object.is(a, e), `rank ${ek[i]}: ${a} vs ${e}`);
  }
}

function check(db, v, params, expectKind) {
  const graph = loadGraph(db);
  const ref = loadGraphRef(db);
  assertRowsMatch(graph, ref);
  if (expectKind) assert.equal(graph.indexKind, expectKind);
  assertRanks(personalizedPageRank(graph, v, params), personalizedPageRankRef(ref, v, params));
  return graph;
}

const P50 = { alpha: 0.4, pprIterations: 50 };

test('an empty edge table is an empty array-indexed graph', () => {
  const db = memoryEdges([]);
  try {
    const graph = check(db, new Map(), P50, 'array');
    assert.equal(graph.ids.size, 0);
    assert.equal(personalizedPageRank(graph, new Map(), P50).size, 0);
    const v = new Map([[4, 1], [7, 3]]);
    const rank = personalizedPageRank(graph, v, { alpha: 0.4, pprIterations: 0 });
    assertRanks(rank, personalizedPageRankRef(loadGraphRef(db), v, { alpha: 0.4, pprIterations: 0 }));
    assert.deepStrictEqual([...rank.keys()], [4, 7]);
    assert.ok(Object.is(rank.get(4), 0.25));
    assert.ok(Object.is(rank.get(7), 0.75));
  } finally {
    db.close();
  }
});

test('node order is first appearance in the edge scan, then teleport-only keys', () => {
  const db = memoryEdges([
    { src: 5, dst: 5, raw: 9 },
    { src: 1, dst: 2, raw: 0.5 },
    { src: 7, dst: 8, raw: -4 },
    { src: 2, dst: 3, raw: 2 },
  ]);
  try {
    const v = new Map([[3, 1], [9, 1], [5, 1]]);
    const graph = check(db, v, { alpha: 0.4, pprIterations: 0 }, 'array');
    assert.deepStrictEqual(graph.idsByIndex, [5, 1, 2, 7, 8, 3]);
    assert.deepStrictEqual(rowOf(graph, 5), []);
    assert.deepStrictEqual(rowOf(graph, 7), []);
    assert.deepStrictEqual(rowOf(graph, 8), []);
    const rank = personalizedPageRank(graph, v, { alpha: 0.4, pprIterations: 0 });
    assert.deepStrictEqual([...rank.keys()], [5, 1, 2, 7, 8, 3, 9]);
    check(db, v, P50, 'array');
  } finally {
    db.close();
  }
});

test('duplicate edges keep first-seen neighbors and max(0, first) then max(current, next)', () => {
  const db = memoryEdges([
    { src: 1, dst: 2, raw: -5 },
    { src: 1, dst: 3, raw: 4 },
    { src: 1, dst: 2, raw: -1 },
    { src: 1, dst: 4, raw: 0 },
  ]);
  try {
    const graph = check(db, new Map([[1, 1], [4, 1], [6, 1]]), P50, 'array');
    const row = rowOf(graph, 1);
    assert.deepStrictEqual(row.map(([id]) => id), [2, 3, 4]);
    assert.ok(Object.is(row[0][1], 0));
    assert.ok(Object.is(row[1][1], 1));
    assert.ok(Object.is(row[2][1], 0));
    assert.deepStrictEqual(rowOf(graph, 2), []);
    assert.deepStrictEqual(rowOf(graph, 4), []);
    assert.deepStrictEqual(rowOf(graph, 3).map(([id]) => id), [1]);
    assert.ok(Object.is(rowOf(graph, 3)[0][1], 1));
  } finally {
    db.close();
  }
});

test('a later reverse edge raises the kept weight, and the first weight wins when it is larger', () => {
  const raised = memoryEdges([
    { src: 1, dst: 2, raw: 2 },
    { src: 1, dst: 3, raw: 2 },
    { src: 2, dst: 1, raw: 6 },
  ]);
  const kept = memoryEdges([
    { src: 1, dst: 2, raw: 9 },
    { src: 1, dst: 2, raw: 1 },
    { src: 1, dst: 3, raw: 3 },
  ]);
  try {
    const g1 = check(raised, new Map([[1, 1]]), { alpha: 0.4, pprIterations: 1 }, 'array');
    const row1 = rowOf(g1, 1);
    assert.deepStrictEqual(row1.map(([id]) => id), [2, 3]);
    assert.ok(Object.is(row1[0][1], 6 / 8));
    assert.ok(Object.is(row1[1][1], 2 / 8));
    const g2 = check(kept, new Map([[2, 1], [3, 1]]), { alpha: 0, pprIterations: 4 }, 'array');
    const row2 = rowOf(g2, 1);
    assert.deepStrictEqual(row2.map(([id]) => id), [2, 3]);
    assert.ok(Object.is(row2[0][1], 9 / 12));
    assert.ok(Object.is(row2[1][1], 3 / 12));
  } finally {
    raised.close();
    kept.close();
  }
});

test('raw wins over rank, including raw 0, and a missing rank is weight 1', () => {
  const db = memoryEdges([
    { src: 1, dst: 2, raw: 0, rank: 9 },
    { src: 3, dst: 4, rank: 3 },
    { src: 3, dst: 5 },
    { src: 3, dst: 4, raw: 0.2 },
  ]);
  try {
    const graph = check(db, new Map([[3, 2], [1, 2]]), P50, 'array');
    assert.deepStrictEqual(rowOf(graph, 1), []);
    assert.deepStrictEqual(rowOf(graph, 2), []);
    // (3,4) is max(1/4, 0.2) = 0.25, then (3,5) is 1. Sum 1.25.
    const row = rowOf(graph, 3);
    assert.deepStrictEqual(row.map(([id]) => id), [4, 5]);
    assert.ok(Object.is(row[0][1], 0.25 / 1.25));
    assert.ok(Object.is(row[1][1], 1 / 1.25));
  } finally {
    db.close();
  }
});

test('rank -1 is an infinite weight and normalizes like the Map walker', () => {
  const db = memoryEdges([
    { src: 1, dst: 2, rank: -1 },
    { src: 1, dst: 3, raw: 5 },
  ]);
  try {
    const graph = check(db, new Map([[1, 1], [2, 1]]), { alpha: 0.4, pprIterations: 3 }, 'array');
    const row = rowOf(graph, 1);
    assert.deepStrictEqual(row.map(([id]) => id), [2, 3]);
    assert.ok(Object.is(row[0][1], NaN));
    assert.ok(Object.is(row[1][1], 0));
    assert.ok(Object.is(rowOf(graph, 2)[0][1], NaN));
    assert.ok(Object.is(rowOf(graph, 3)[0][1], 1));
  } finally {
    db.close();
  }
});

test('disconnected components, dangling nodes, and a teleport-only artist share one ranking', () => {
  const db = memoryEdges([
    { src: 1, dst: 2, raw: 0.3 },
    { src: 1, dst: 2, raw: 0.7 },
    { src: 10, dst: 11 },
    { src: 10, dst: 12, rank: 4 },
    { src: 20, dst: 20, raw: 1 },
  ]);
  try {
    const v = new Map([[12, 1], [1, 1], [50, 1]]);
    const graph = check(db, v, P50, 'array');
    assert.deepStrictEqual(graph.idsByIndex, [1, 2, 10, 11, 12, 20]);
    assert.deepStrictEqual(rowOf(graph, 1).map(([id]) => id), [2]);
    assert.deepStrictEqual(rowOf(graph, 10).map(([id]) => id), [11, 12]);
    assert.deepStrictEqual(rowOf(graph, 20), []);
    const rank = personalizedPageRank(graph, v, { alpha: 0.4, pprIterations: 0 });
    assert.deepStrictEqual([...rank.keys()], [1, 2, 10, 11, 12, 20, 50]);
    check(db, new Map(), { alpha: 1, pprIterations: 7 }, 'array');
  } finally {
    db.close();
  }
});

test('a non-positive teleport becomes uniform, and one push matches the dangling-mass formula', () => {
  const db = memoryEdges([
    { src: 1, dst: 2, raw: 1 },
    { src: 2, dst: 3, raw: 1 },
  ]);
  try {
    const negative = new Map([[1, -1], [2, -1], [9, 0]]);
    const graph = check(db, negative, { alpha: 0.4, pprIterations: 0 }, 'array');
    const uniform = personalizedPageRank(graph, negative, { alpha: 0.4, pprIterations: 0 });
    assert.deepStrictEqual([...uniform.keys()], [1, 2, 3, 9]);
    for (const value of uniform.values()) assert.ok(Object.is(value, 0.25));
    check(db, negative, { alpha: 0.4, pprIterations: 6 }, 'array');

    const placed = personalizedPageRank(graph, new Map([[1, 2], [9, 2]]), { alpha: 0.4, pprIterations: 0 });
    assert.deepStrictEqual([...placed.keys()], [1, 2, 3, 9]);
    assert.ok(Object.is(placed.get(1), 0.5));
    assert.ok(Object.is(placed.get(2), 0));
    assert.ok(Object.is(placed.get(3), 0));
    assert.ok(Object.is(placed.get(9), 0.5));

    const one = memoryEdges([{ src: 1, dst: 2, raw: 1 }]);
    try {
      const g = check(one, new Map([[1, 1]]), { alpha: 0.4, pprIterations: 1 }, 'array');
      const rank = personalizedPageRank(g, new Map([[1, 1]]), { alpha: 0.4, pprIterations: 1 });
      assert.deepStrictEqual([...rank.keys()], [1, 2]);
      assert.ok(Object.is(rank.get(1), 0.4));
      assert.ok(Object.is(rank.get(2), 1 - 0.4));
    } finally {
      one.close();
    }
  } finally {
    db.close();
  }
});

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weighted(src, dst, rand) {
  const u = rand();
  if (u < 0.12) return { src, dst, raw: -rand() * 5 };
  if (u < 0.22) return { src, dst, raw: 0 };
  if (u < 0.4) return { src, dst, rank: Math.floor(rand() * 11) };
  return { src, dst, raw: rand() };
}

function randomEdges(seed) {
  const rand = mulberry32(seed);
  const rows = [];
  const pick = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  for (let i = 0; i < 180; i++) {
    const src = pick(1, 20);
    const dst = rand() < 0.05 ? src : pick(1, 20);
    rows.push(weighted(src, dst, rand));
  }
  for (let i = 0; i < 80; i++) {
    const src = pick(21, 35);
    const dst = rand() < 0.08 ? src : pick(21, 35);
    rows.push(weighted(src, dst, rand));
  }
  rows.push({ src: 36, dst: 37, raw: -2 }, { src: 36, dst: 37, raw: -0.5 });
  rows.push({ src: 1, dst: 36, raw: 0 });
  rows.push({ src: 38, dst: 38, raw: 3 });
  rows.push({ src: 1, dst: 2, raw: 0.9 });
  return rows;
}

test('a seeded random graph matches the reference for every checked alpha and iteration count', () => {
  const db = memoryEdges(randomEdges(0xC0FFEE));
  const vs = [
    new Map([[1, 0.4], [21, 0.2], [38, 0.1], [36, 0.1], [99, 0.2], [40, 0]]),
    new Map(),
    new Map([[1, 1], [2, -1], [41, 0.5]]),
  ];
  const params = [
    P50,
    { alpha: 0.4, pprIterations: 0 },
    { alpha: 0.4, pprIterations: 1 },
    { alpha: 0, pprIterations: 5 },
    { alpha: 1, pprIterations: 5 },
    { alpha: 0.3, pprIterations: 11 },
  ];
  try {
    for (const v of vs) {
      for (const p of params) check(db, v, p, 'array');
    }
  } finally {
    db.close();
  }
});

test('a modest max id uses the Int32Array index, including a teleport id past the table', () => {
  const db = memoryEdges([
    { src: 1, dst: 100_000, raw: 0.4 },
    { src: 100_000, dst: 2, raw: 0.2 },
  ]);
  try {
    check(db, new Map([[1, 1], [8_000_001, 1]]), P50, 'array');
  } finally {
    db.close();
  }
});

test('sparse multi-million ids fall back to Map and still match', () => {
  const rows = randomEdges(0xA11CE).map((r) => ({ ...r, src: r.src + 2_000_000, dst: r.dst + 2_000_000 }));
  const db = memoryEdges(rows);
  const v = new Map([[2_000_001, 1], [2_000_038, 1], [7, 1]]);
  try {
    check(db, v, P50, 'map');
    check(db, v, { alpha: 0.5, pprIterations: 2 }, 'map');
  } finally {
    db.close();
  }
});

test('a negative artist id uses the Map index and keeps first-seen order', () => {
  const db = memoryEdges([
    { src: -2, dst: -1, raw: 0.5 },
    { src: -1, dst: 4, raw: -3 },
    { src: 4, dst: 5, raw: 2 },
    { src: 5, dst: 5, raw: 1 },
    { src: 4, dst: -1, raw: 4 },
  ]);
  try {
    const v = new Map([[-2, 1], [5, 1], [8, 1]]);
    const graph = check(db, v, P50, 'map');
    assert.deepStrictEqual(graph.idsByIndex, [-2, -1, 4, 5]);
    assert.deepStrictEqual([...personalizedPageRank(graph, v, { alpha: 0.4, pprIterations: 0 }).keys()], [-2, -1, 4, 5, 8]);
  } finally {
    db.close();
  }
});

test('the real edge table matches, including a second source and rank -1', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    initMainSchema(db);
    db.exec(`INSERT INTO artist (id, name) VALUES (1, 'A'), (2, 'B'), (3, 'C'), (4, 'D')`);
    const ins = db.prepare(`INSERT INTO edge (src, dst, source, rank, raw, fetched_at) VALUES (?, ?, ?, ?, ?, 1)`);
    ins.run(1, 2, 'lb:similar-artists:a', 1, 0.4);
    ins.run(1, 2, 'lb:similar-artists:b', null, null);
    ins.run(2, 3, 'lb:similar-artists:a', -1, null);
    ins.run(3, 4, 'lb:similar-artists:a', 3, null);
    ins.run(4, 1, 'lb:similar-artists:a', 0, 0);
    const v = new Map([[1, 1], [9, 1]]);
    check(db, v, { alpha: 0.4, pprIterations: 15 }, 'array');
    check(db, new Map([[4, -2], [3, 0.5]]), { alpha: 0.4, pprIterations: 0 }, 'array');
  } finally {
    db.close();
  }
});
