const MAX_HOPS = 32;

export function canon(d, table, id, maxHops = MAX_HOPS) {
  const seen = new Set();
  let cur = id;
  while (true) {
    if (seen.has(cur) || seen.size > maxHops) throw new Error(`${table} merge cycle at ${id}`);
    seen.add(cur);
    const r = d.prepare(`SELECT merged_into FROM ${table} WHERE id=?`).get(cur);
    if (!r) throw new Error(`no ${table} ${cur}`);
    if (r.merged_into == null) return cur;
    cur = r.merged_into;
  }
}

export function canonOrNull(d, table, id, maxHops = MAX_HOPS) {
  if (id == null) return null;
  const seen = new Set();
  let cur = id;
  while (true) {
    if (seen.has(cur) || seen.size > maxHops) throw new Error(`${table} merge cycle at ${id}`);
    seen.add(cur);
    const r = d.prepare(`SELECT merged_into FROM ${table} WHERE id=?`).get(cur);
    if (!r) return null;
    if (r.merged_into == null) return cur;
    cur = r.merged_into;
  }
}

/** Merge `from` into `into`, flattening merged_into to a single hop to the root. Never deletes rows. */
export function merge(d, table, from, into) {
  const target = canon(d, table, into);
  const source = canon(d, table, from);
  if (source === target) throw new Error(`${table} merge would create a cycle`);
  d.prepare(`UPDATE ${table} SET merged_into=? WHERE id=?`).run(target, source);
  d.prepare(`UPDATE ${table} SET merged_into=? WHERE merged_into=?`).run(target, source);
  return target;
}

export function identity(d, tid) {
  const row = d.prepare(`SELECT mbid, title_norm FROM track WHERE id=?`).get(tid);
  if (!row) return null;
  const isrcs = d.prepare(`SELECT isrc FROM track_isrc WHERE track_id=?`).all(tid).map((r) => r.isrc);
  return { mbid: row.mbid ?? null, title_norm: row.title_norm, isrcs };
}

/** Cache/miss rows describe the same recording as the snapshot track. */
export function sameRecording(row, id) {
  if (!row || !id) return false;
  if (row.recording_mbid != null) return row.recording_mbid === id.mbid;
  return id.isrcs.includes(row.isrc) && row.title_norm === id.title_norm;
}
