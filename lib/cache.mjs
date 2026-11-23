export function cacheGet(db, endpoint, key, nowSec) {
  const row = db.prepare(`SELECT status, body, fetched_at, next_fetch_at FROM fetch_cache WHERE endpoint=? AND key=?`).get(endpoint, key);
  if (!row) return null;
  if (nowSec != null && row.next_fetch_at <= nowSec) return { ...row, stale: true, body: row.body ? JSON.parse(row.body) : null };
  return { ...row, stale: false, body: row.body ? JSON.parse(row.body) : null };
}

export function cachePut(db, endpoint, key, { status, body, fetchedAt, nextFetchAt }) {
  const text = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
  db.prepare(
    `INSERT INTO fetch_cache (endpoint, key, status, body, fetched_at, next_fetch_at) VALUES (?,?,?,?,?,?)
     ON CONFLICT(endpoint, key) DO UPDATE SET status=excluded.status, body=excluded.body, fetched_at=excluded.fetched_at, next_fetch_at=excluded.next_fetch_at`,
  ).run(endpoint, key, status, text, fetchedAt, nextFetchAt);
}
