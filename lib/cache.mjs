/** A row whose body does not parse (written by an older version) reads as missing, so it is fetched again. */
export function cacheGet(db, endpoint, key, nowSec) {
  const row = db.prepare(`SELECT status, body, fetched_at, next_fetch_at FROM fetch_cache WHERE endpoint=? AND key=?`).get(endpoint, key);
  if (!row) return null;
  let body = null;
  if (row.body != null) {
    try { body = JSON.parse(row.body); } catch { return null; }
  }
  return { ...row, stale: nowSec != null && row.next_fetch_at <= nowSec, body };
}

export function cachePut(db, endpoint, key, { status, body, fetchedAt, nextFetchAt }) {
  db.prepare(
    `INSERT INTO fetch_cache (endpoint, key, status, body, fetched_at, next_fetch_at) VALUES (?,?,?,?,?,?)
     ON CONFLICT(endpoint, key) DO UPDATE SET status=excluded.status, body=excluded.body, fetched_at=excluded.fetched_at, next_fetch_at=excluded.next_fetch_at`,
  ).run(endpoint, key, status, body == null ? null : JSON.stringify(body), fetchedAt, nextFetchAt);
}
