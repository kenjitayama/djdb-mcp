import { linkSync, readFileSync, readdirSync, rmSync, mkdtempSync, mkdirSync, openSync, closeSync, writeSync, unlinkSync, existsSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
const openSnap = (abs) => { const u = pathToFileURL(abs); u.searchParams.set('immutable', '1'); return new DatabaseSync(u, { readOnly: true }); };

const fail = (m) => { console.error('FAIL', m); process.exit(1); };
// Runtime check, same range as engines: >=24.15.0 <25 || >=26 <27
const nodeSupported = (v = process.versions.node) => { const [a, b] = v.split('.').map(Number); return (a === 24 && b >= 15) || a === 26; };
const rangeCases = { '20.18.0': false, '22.13.0': false, '24.14.9': false, '24.15.0': true, '24.22.1': true, '25.7.0': false, '26.0.0': true, '26.13.1': true, '27.0.0': false };
for (const [v, want] of Object.entries(rangeCases)) if (nodeSupported(v) !== want) fail('range ' + v);
console.log('RANGE_OK', Object.keys(rangeCases).length, 'cases');
if (!nodeSupported()) { console.error(`Node ${process.versions.node} unsupported`); process.exit(2); }
console.log('NODE', process.versions.node, 'sqlite', process.versions.sqlite);

const SCHEMA = readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8');
const ONLINE_SCHEMA = readFileSync(new URL('../sql/schema-online.sql', import.meta.url), 'utf8');
const LIB_USER_VERSION = { min: 1, max: 1 };
const root = mkdtempSync(join(tmpdir(), 'djdb-v11-'));
const dbPath = join(root, 'djdb.sqlite'), onlinePath = join(root, 'djdb-online.sqlite'), snapsDir = join(root, 'snapshots'), lockPath = join(root, 'djdb.lock');
mkdirSync(snapsDir);
const openDb = (p = dbPath) => { const d = new DatabaseSync(p); d.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;'); return d; };
let db = openDb();
const odb = openDb(onlinePath);
try { db.exec(SCHEMA); odb.exec(ONLINE_SCHEMA); console.log('PARSE_OK: main + online schema exec succeeded (node:sqlite DatabaseSync)'); } catch (e) { fail('parse ' + e.message); }
const count = (d, t) => d.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='${t}' AND name NOT LIKE 'sqlite_%'`).get().n;
for (const [name, d] of [['MAIN', db], ['ONLINE', odb]]) console.log(name, 'USER_VERSION', d.prepare('PRAGMA user_version').get().user_version, 'TABLES', count(d, 'table'), 'TRIGGERS', count(d, 'trigger'), 'INDEXES', count(d, 'index'));
console.log('TOTAL TABLES', count(db, 'table') + count(odb, 'table'), 'TOTAL TRIGGERS', count(db, 'trigger') + count(odb, 'trigger'));

let rejects = 0, checks = 0;
function mustThrow(label, fn, d = db) {
  d.exec('SAVEPOINT t');
  try { fn(); } catch (e) { d.exec('ROLLBACK TO t; RELEASE t'); rejects++; console.log('REJECT_OK:', label, '-', String(e.message).split('\n')[0]); return; }
  fail('expected rejection: ' + label);
}
const check = (label, cond) => { if (!cond) fail(label); checks++; console.log('CHECK_OK:', label); };
const one = (q, ...a) => db.prepare(q).get(...a);
const oone = (q, ...a) => odb.prepare(q).get(...a);
const oall = (q, ...a) => odb.prepare(q).all(...a);
const all = (q, ...a) => db.prepare(q).all(...a);
const meta = (k) => one(`SELECT value FROM meta WHERE key=?`, k)?.value;
const setMeta = (k, v) => db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(k, v);
const now = 1_800_000_000, DAY = 86400;

// ---------- lock file: only the creator deletes it ----------
function withLock(command, fn) {
  const token = randomUUID();
  let fd;
  try { fd = openSync(lockPath, 'wx'); }
  catch (e) { if (e.code === 'EEXIST') return { locked: true, holder: JSON.parse(readFileSync(lockPath, 'utf8')) }; throw e; }
  // acquired: from here on, and only here, we may delete the lock
  try { writeSync(fd, JSON.stringify({ pid: process.pid, token, command, started_at: now })); closeSync(fd); return { result: fn() }; }
  finally {
    try { const cur = JSON.parse(readFileSync(lockPath, 'utf8')); if (cur.pid === process.pid && cur.token === token) unlinkSync(lockPath); } catch { /* already gone */ }
  }
}
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function lockStatus() {
  if (!existsSync(lockPath)) return null;
  const h = JSON.parse(readFileSync(lockPath, 'utf8'));
  return pidAlive(h.pid) ? `refresh running (pid ${h.pid}, ${h.command}, since ${h.started_at})`
                         : `stale lock (pid ${h.pid}, ${h.command}, since ${h.started_at}): run djdb unlock --force`;
}
function unlockForce(confirm) { // shows pid/command/start and asks
  if (!existsSync(lockPath)) return 'no lock';
  const h = JSON.parse(readFileSync(lockPath, 'utf8'));
  const prompt = `lock held by pid ${h.pid} (${h.command}, since ${h.started_at}). delete? [y/N]`;
  if (!confirm(prompt)) return 'kept'; unlinkSync(lockPath); return 'deleted';
}
{
  const inner = [];
  const outer = withLock('refresh', () => { inner.push(withLock('refresh', () => 'x')); return existsSync(lockPath); });
  check('overlapping refresh is refused and does NOT delete the first lock', inner[0].locked && outer.result === true);
  check('creator removes its own lock', !existsSync(lockPath));
  writeFileJSON(lockPath, { pid: 999999999, token: 'other', command: 'refresh', started_at: now - 3600 });
  const r = withLock('refresh', () => 'ran');
  check('stale lock blocks refresh and survives the failed attempt', r.locked && existsSync(lockPath));
  check('status() shows stale lock with pid/time and the unlock command', /stale lock \(pid 999999999, refresh, since \d+\): run djdb unlock --force/.test(lockStatus()));
  let shown = ''; check('unlock --force asks and keeps on N', unlockForce((p) => { shown = p; return false; }) === 'kept' && /pid 999999999/.test(shown));
  check('unlock --force deletes on y', unlockForce(() => true) === 'deleted' && !existsSync(lockPath));
}
function writeFileJSON(p, o) { const fd = openSync(p, 'wx'); writeSync(fd, JSON.stringify(o)); closeSync(fd); }

// ---------- init ----------
const accountKey = randomUUID();
db.exec(`INSERT INTO meta (key, value) VALUES ('lb_account_key','${accountKey}'),('lb_user','someone'),('dirty','1')`);
odb.exec(`INSERT INTO meta (key, value) VALUES ('main_db_key','${accountKey}')`);
check('online DB is bound to this main DB (main_db_key = lb_account_key)', oone(`SELECT value FROM meta WHERE key='main_db_key'`).value === meta('lb_account_key'));
db.exec(`INSERT INTO artist (id, name) VALUES (1,'A'),(2,'B'),(3,'C');
  INSERT INTO artist_alias (alias_norm, artist_id, source, norm_version) VALUES ('the a',1,'lb',1);
  INSERT INTO track (id, title, title_norm, norm_version, artist_credit) VALUES (10,'T','t',1,'A'),(11,'T','t',1,'A'),(12,'U','u',1,'A'),(13,'V','v',1,'A');
  INSERT INTO track_artist (track_id, position, artist_id) VALUES (10,0,1),(11,0,1),(12,0,1),(13,0,1);`);

// ---------- refresh batches: dirty=1 in the same transaction as the change ----------
function batch(fn) { db.exec('BEGIN IMMEDIATE'); try { const changed = fn(); if (changed > 0) db.exec(`UPDATE meta SET value='1' WHERE key='dirty'`); db.exec('COMMIT'); return changed; } catch (e) { db.exec('ROLLBACK'); throw e; } }
db.exec(`UPDATE meta SET value='0' WHERE key='dirty'`);
try { batch(() => { db.exec(`INSERT INTO play (source_key, origin, origin_version, via, via_version, played_at, raw_artist, raw_title) VALUES ('lb:1|a','spotify',1,'lb:lastfm',1,1,'A','T')`); throw new Error('crash mid-batch'); }); } catch {}
check('crashed batch leaves neither the row nor dirty=1', meta('dirty') === '0' && one(`SELECT count(*) AS n FROM play`).n === 0);
const ins = db.prepare(`INSERT INTO play (id, source_key, origin, origin_version, via, via_version, played_at, raw_artist, raw_title, raw_json) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_key) DO NOTHING`);
const n1 = batch(() => ins.run(100, 'lb:1000|m1', 'spotify', 1, 'lb:lastfm', 1, 1000, 'A', 'T', '{"v":1}').changes);
check('committed batch sets dirty=1 atomically', n1 === 1 && meta('dirty') === '1');
db.exec(`UPDATE meta SET value='0' WHERE key='dirty'`);
const n2 = batch(() => ins.run(999, 'lb:1000|m1', 'spotify', 1, 'lb:spotify', 1, 1000, 'A', 'T', '{"v":2}').changes);
check('re-fetch is ignored (ON CONFLICT DO NOTHING) and does not set dirty', n2 === 0 && meta('dirty') === '0' && one(`SELECT raw_json FROM play WHERE id=100`).raw_json === '{"v":1}');
batch(() => db.prepare(`UPDATE play SET lb_recording_mbid=?, lb_mapping_at=? WHERE id=100 AND lb_recording_mbid IS NOT ?`).run('rec-mbid', now, 'rec-mbid').changes);
check('mapping UPDATE is a separate statement and sets dirty', meta('dirty') === '1' && one(`SELECT lb_recording_mbid AS m FROM play WHERE id=100`).m === 'rec-mbid');
mustThrow('raw_json immutable', () => db.exec(`UPDATE play SET raw_json='{}' WHERE id=100`));
mustThrow('source_key immutable', () => db.exec(`UPDATE play SET source_key='lb:2|x' WHERE id=100`));

// ---------- snapshot publication: unique path -> verify -> INSERT + dirty=0 in one commit ----------
function publishSnapshot({ crashAfterVacuum = false, keepDirty = false } = {}) {
  const rel = `snap-${randomUUID()}.db`, abs = resolve(snapsDir, rel);
  if (!abs.startsWith(resolve(snapsDir) + sep)) throw new Error('path escapes snapshots/');
  db.exec(`VACUUM INTO '${abs.replace(/'/g, "''")}'`);
  if (crashAfterVacuum) throw new Error('crash after VACUUM INTO');
  { const w = new DatabaseSync(abs); w.exec('PRAGMA journal_mode=DELETE'); w.close(); } // before hashing: no -wal/-shm, stable bytes
  const sha = createHash('sha256').update(readFileSync(abs)).digest('hex');
  const s = openSnap(abs);
  const okSnap = s.prepare('PRAGMA integrity_check').get().integrity_check === 'ok';
  const uv = s.prepare('PRAGMA user_version').get().user_version; s.close();
  if (!okSnap || createHash('sha256').update(readFileSync(abs)).digest('hex') !== sha) { unlinkSync(abs); throw new Error('snapshot verify failed'); }
  db.exec('BEGIN IMMEDIATE');
  try { db.prepare(`INSERT INTO snapshot (created_at, path, sha256, user_version) VALUES (?,?,?,?)`).run(now, rel, sha, uv);
        db.exec(`UPDATE meta SET value='${keepDirty ? 1 : 0}' WHERE key='dirty'`); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  return rel;
}
function cleanupUnregistered() {
  const known = new Set(all(`SELECT path FROM snapshot`).map((r) => r.path));
  const gone = readdirSync(snapsDir).filter((f) => !known.has(f));
  for (const f of gone) unlinkSync(join(snapsDir, f));
  return gone.length;
}
try { publishSnapshot({ crashAfterVacuum: true }); } catch {}
check('crash after VACUUM INTO: no row, dirty still 1, one orphan file', one(`SELECT count(*) AS n FROM snapshot`).n === 0 && meta('dirty') === '1' && readdirSync(snapsDir).length === 1);
check('next refresh start deletes the unregistered file', cleanupUnregistered() === 1 && readdirSync(snapsDir).length === 0);
const rel1 = publishSnapshot();
check('published: row + dirty=0 together, file registered', meta('dirty') === '0' && one(`SELECT count(*) AS n FROM snapshot`).n === 1 && cleanupUnregistered() === 0 && existsSync(join(snapsDir, rel1)));
mustThrow('pinned without label', () => db.exec(`UPDATE snapshot SET pinned=1`));

// ---------- the whole refresh: stages are in-process functions under one lock ----------
// snapshot check: file present, SHA-256, quick_check; read-only open never sets journal_mode
function snapshotOk(row) { const abs = join(snapsDir, row.path);
  if (!existsSync(abs)) return false;
  if (createHash('sha256').update(readFileSync(abs)).digest('hex') !== row.sha256) return false;
  try { const d = openSnap(abs); const ok = d.prepare('PRAGMA quick_check').get().quick_check === 'ok'; d.close(); return ok; } catch { return false; } }
let validSnapshotIds = new Set(), badPinned = [];
function validateSnapshots() { // refresh start, under the lock: newest first; corrupt unpinned rows are cleaned up
  validSnapshotIds = new Set(); badPinned = [];
  for (const r of all(`SELECT id, path, sha256, pinned FROM snapshot ORDER BY id DESC`)) {
    if (snapshotOk(r)) { validSnapshotIds.add(r.id); continue; }
    if (r.pinned) { badPinned.push(r.id); continue; }
    db.prepare(`DELETE FROM snapshot WHERE id=?`).run(r.id); try { unlinkSync(join(snapsDir, r.path)); } catch {} } }
function refresh(stages) {
  return withLock('refresh', () => {
    cleanupUnregistered(); validateSnapshots();
    const uv = db.prepare('PRAGMA user_version').get().user_version;
    if (uv < LIB_USER_VERSION.max) { /* migrate */ batch(() => 1); }
    for (const s of stages) { if (!s.ok) {
        if (validSnapshotIds.size === 0) { publishSnapshot({ keepDirty: true }); setMeta('refresh_note', `snapshot taken after stage ${s.name} failed`); return `stage ${s.name} failed; fallback snapshot`; }
        return `stage ${s.name} failed`; }
      if (s.changed) batch(() => s.changed); }
    setMeta('refresh_note', '');
    if (meta('dirty') !== '1' && validSnapshotIds.size > 0) return 'no change';
    publishSnapshot(); return 'snapshot';
  }).result;
}
const four = (c) => ['lb-sync', 'match', 'graph-build', 'popularity-refresh'].map((name, i) => ({ name, changed: c[i], ok: true }));
db.exec(`UPDATE meta SET value='0' WHERE key='dirty'`);
const flow = [refresh(four([1, 0, 0, 0])), refresh(four([0, 0, 0, 0])), refresh(four([4, 0, 0, 0])),
  refresh([{ name: 'lb-sync', changed: 2, ok: true }, { name: 'match', ok: false }]), refresh(four([0, 0, 0, 0]))];
console.log('REFRESH_FLOW', JSON.stringify(flow));
check('refresh flow (failure keeps dirty for the next run)', JSON.stringify(flow) === JSON.stringify(['snapshot', 'no change', 'snapshot', 'stage match failed', 'snapshot']));
function status(dbUv) {
  const lock = lockStatus(); if (lock) return lock;
  if (dbUv < LIB_USER_VERSION.min || dbUv > LIB_USER_VERSION.max) return 'schema changed: run djdb refresh';
  const latest = one(`SELECT user_version FROM snapshot ORDER BY id DESC LIMIT 1`);
  if (!latest) return 'no snapshot: run djdb refresh';
  if (latest.user_version < LIB_USER_VERSION.min) return 'schema changed: run djdb refresh';
  return 'ok';
}
check('status() after a schema migration says "run djdb refresh"', status(0) === 'schema changed: run djdb refresh' && status(1) === 'ok');

// ---------- merged_into: cycle-safe for artist and track ----------
function canon(table, id, maxHops = 32) { const seen = new Set();
  while (true) { if (seen.has(id) || seen.size > maxHops) throw new Error(`${table} merge cycle at ${id}`); seen.add(id);
    const r = one(`SELECT merged_into FROM ${table} WHERE id=?`, id); if (!r) throw new Error(`no ${table} ${id}`); if (r.merged_into == null) return id; id = r.merged_into; } }
function merge(table, from, into) { const target = canon(table, into); if (canon(table, from) === target) throw new Error(`${table} merge would create a cycle`);
  db.prepare(`UPDATE ${table} SET merged_into=? WHERE id=?`).run(target, from); }
for (const t of ['artist', 'track']) {
  const [a, b, c] = t === 'artist' ? [1, 2, 3] : [11, 12, 13];
  merge(t, a, b); merge(t, b, c);
  check(`${t}: chain flattened to the root on merge`, canon(t, a) === c);
  let refused = false; try { merge(t, c, a); } catch { refused = true; }
  check(`${t}: merge that would make a cycle is refused (visited set)`, refused);
  db.exec(`UPDATE ${t} SET merged_into=${a} WHERE id=${c}`); // inject a cycle behind the code's back
  let caught = false; try { canon(t, a); } catch (e) { caught = /cycle/.test(e.message); }
  check(`${t}: read stops on an injected cycle instead of looping`, caught);
  db.exec(`UPDATE ${t} SET merged_into=NULL WHERE id IN (${a},${b},${c})`);
}
mustThrow('self merge', () => db.exec(`UPDATE track SET merged_into=10 WHERE id=10`));

// ---------- cross-DB identity: AUTOINCREMENT ids, cache rows carry identity, run-local canonicalization ----------
db.exec(`INSERT INTO meta (key, value) VALUES ('id_epoch','${randomUUID()}')`);
odb.exec(`INSERT INTO meta (key, value) VALUES ('id_epoch','${meta('id_epoch')}')`);
db.exec(`UPDATE track SET mbid='m10' WHERE id=10; UPDATE track SET mbid='m12' WHERE id=12;
  INSERT INTO track_isrc (isrc, track_id) VALUES ('JPX1',11),('JPX1',10);`);
{ db.exec(`INSERT INTO track (title, title_norm, norm_version, artist_credit) VALUES ('tmp','tmp',1,'A')`);
  const top = one(`SELECT max(id) AS m FROM track`).m; db.exec(`DELETE FROM track WHERE id=${top}`);
  db.exec(`INSERT INTO track (title, title_norm, norm_version, artist_credit) VALUES ('tmp2','tmp2',1,'A')`);
  const again = one(`SELECT max(id) AS m FROM track`).m; db.exec(`DELETE FROM track WHERE id=${again}`);
  check('AUTOINCREMENT: a deleted max id is never handed out again', again > top); }
function canonIn(d, table, id, maxHops = 32) { const seen = new Set();
  while (true) { if (seen.has(id) || seen.size > maxHops) throw new Error(`${table} merge cycle at ${id}`); seen.add(id);
    const r = d.prepare(`SELECT merged_into FROM ${table} WHERE id=?`).get(id); if (!r) return null; if (r.merged_into == null) return id; id = r.merged_into; } }
const identity = (d, tid) => ({ ...d.prepare(`SELECT mbid, title_norm FROM track WHERE id=?`).get(tid), isrcs: d.prepare(`SELECT isrc FROM track_isrc WHERE track_id=?`).all(tid).map((r) => r.isrc) });
const sameRecording = (row, id) => row.recording_mbid != null ? row.recording_mbid === id.mbid : (id.isrcs.includes(row.isrc) && row.title_norm === id.title_norm);
function cachedId(snapDb, tid) { // recommend(): reuse only when the cache row still describes the snapshot's track
  const id = identity(snapDb, tid);
  return odb.prepare(`SELECT * FROM track_external_id WHERE track_id=? AND provider='spotify' AND status='ok'`).all(tid).find((r) => sameRecording(r, id))?.ext_id ?? null; }
function onlineReset(conn = odb, { onlyIfEpochDiffers = false } = {}) { // in place, one exclusive transaction, same file (no rename)
  const odb = conn; odb.exec('BEGIN EXCLUSIVE');
  try { if (onlyIfEpochDiffers && odb.prepare(`SELECT value FROM meta WHERE key='id_epoch'`).get()?.value === meta('id_epoch')) { odb.exec('COMMIT'); return 'already reset'; }
    odb.exec('DELETE FROM rec_event; DELETE FROM rec_item_playable; DELETE FROM rec_item; DELETE FROM rec_run; DELETE FROM track_external_id; DELETE FROM track_resolve_miss; DELETE FROM meta');
    odb.prepare(`INSERT INTO meta (key, value) VALUES ('main_db_key', ?), ('id_epoch', ?)`).run(meta('lb_account_key'), meta('id_epoch')); odb.exec('COMMIT');
    return 'reset: restart running dj-mcp processes (their writes to old run ids now fail harmlessly)'; }
  catch (e) { odb.exec('ROLLBACK'); throw e; } }
function epochCheck() { const m = meta('id_epoch'), o = oone(`SELECT value FROM meta WHERE key='id_epoch'`)?.value;
  if (m === o) return 'ok';
  onlineReset(odb, { onlyIfEpochDiffers: true }); return 'online DB reset'; }
const log = [];
function recordExternalIds(snapDb, runId, items, market = 'JP') { // ids come from rec_item (snapshot-time track_id + MBID/ISRC), never from the main DB
  odb.exec('BEGIN IMMEDIATE');
  try {
    if (!oone(`SELECT 1 AS x FROM rec_run WHERE id=?`, runId)) { odb.exec('ROLLBACK'); return { error: 'unknown_run' }; } // non-fatal for dj-mcp
    for (const it of items) {
      const ri = oone(`SELECT track_id, recording_mbid, isrc, title_norm FROM rec_item WHERE run_id=? AND rank=?`, runId, it.rank);
      const tid = ri.track_id;
      if (it.status === 'ok') {
        const cur = oone(`SELECT track_id FROM track_external_id WHERE provider=? AND ext_id=?`, it.provider, it.extId);
        if (cur && canonIn(snapDb, 'track', cur.track_id) !== tid) { log.push(`conflict ${it.provider}:${it.extId}`); // skip only the cache write
          odb.prepare(`INSERT OR IGNORE INTO rec_item_playable (run_id, rank, provider, ext_id, play_uri, market, resolved_by, resolved_at) VALUES (?,?,?,?,?,?,'client',?)`).run(runId, it.rank, it.provider, it.extId, it.playUri, market, now); continue; }
        odb.prepare(`INSERT INTO track_external_id (track_id, recording_mbid, isrc, title_norm, provider, ext_id, play_uri, market, method, verified_at) VALUES (?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT (provider, ext_id) DO UPDATE SET track_id=excluded.track_id, recording_mbid=excluded.recording_mbid, isrc=excluded.isrc, title_norm=excluded.title_norm`)
          .run(tid, ri.recording_mbid, ri.isrc, ri.title_norm, it.provider, it.extId, it.playUri, market, 'spotify_isrc_search', now);
        odb.prepare(`DELETE FROM track_resolve_miss WHERE track_id=? AND provider=? AND market=?`).run(tid, it.provider, market);
      } else if (it.status === 'not_found') { // only for a successful search with 0 results
        if (oone(`SELECT 1 AS x FROM track_external_id WHERE track_id=? AND provider=? AND status='ok'`, tid, it.provider)) { log.push(`not_found ignored: ${tid} already has an id`); continue; }
        odb.prepare(`INSERT INTO track_resolve_miss (track_id, recording_mbid, isrc, title_norm, provider, market, tried_at, next_try_at) VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT (track_id, provider, market) DO UPDATE SET tried_at=excluded.tried_at, next_try_at=excluded.next_try_at`).run(tid, ri.recording_mbid, ri.isrc, ri.title_norm, it.provider, market, now, now + 30 * DAY);
      } else throw new Error('429/network errors are not recorded');
    }
    odb.exec('COMMIT'); return { ok: true };
  } catch (e) { odb.exec('ROLLBACK'); throw e; }
}
function recordEvent(runId, rank, kind) {
  odb.exec('BEGIN IMMEDIATE');
  try { if (!oone(`SELECT 1 AS x FROM rec_item WHERE run_id=? AND rank=?`, runId, rank)) { odb.exec('ROLLBACK'); return { error: 'unknown_run' }; }
    odb.prepare(`INSERT INTO rec_event (run_id, rank, kind, at) VALUES (?,?,?,?)`).run(runId, rank, kind, now); odb.exec('COMMIT'); return { ok: true }; }
  catch (e) { odb.exec('ROLLBACK'); throw e; } }
const latestSnap = () => one(`SELECT id, path, sha256 FROM snapshot ORDER BY id DESC LIMIT 1`);
db.exec(`UPDATE meta SET value='1' WHERE key='dirty'`); publishSnapshot();
const S1 = latestSnap(), s1 = new DatabaseSync(join(snapsDir, S1.path), { readOnly: true });
const mainChangesBefore = db.prepare('SELECT total_changes() AS n').get().n;
const newRun = (id, S) => odb.prepare(`INSERT INTO rec_run (id, created_at, snapshot_id, snapshot_sha256, mode, algo_version, params_hash, params_json) VALUES (?,?,?,?,?,?,?,?)`).run(id, now, S.id, S.sha256, 'discover', 'v9', 'h', '{}');
const addItem = (run, rank, snapDb, tid) => { const c = canonIn(snapDb, 'track', tid), id = identity(snapDb, c);
  odb.prepare(`INSERT INTO rec_item (run_id, rank, artist_id, track_id, recording_mbid, isrc, title_norm, score) VALUES (?,?,1,?,?,?,?,0.5)`).run(run, rank, c, id.mbid ?? null, id.isrcs[0] ?? null, id.title_norm); };
newRun(101, S1); addItem(101, 1, s1, 11); addItem(101, 2, s1, 12);
recordExternalIds(s1, 101, [{ rank: 1, provider: 'spotify', status: 'ok', extId: 'xyz', playUri: 'spotify:track:xyz' }]);
batch(() => { merge('track', 11, 10); return 1; }); // refresh merges 11 -> 10 in the main DB, then fails: main dirty, S1 still latest
check('within a run, candidates are canonicalized with the run snapshot only (dirty main merge ignored)', canonIn(s1, 'track', 11) === 11 && canonIn(db, 'track', 11) === 10 && cachedId(s1, 11) === 'xyz');
recordExternalIds(s1, 101, [{ rank: 2, provider: 'spotify', status: 'ok', extId: 'xyz', playUri: 'spotify:track:xyz' }]);
check('different-root conflict: cache write skipped, ID still recorded in rec_item_playable (client) and presented', log.at(-1) === 'conflict spotify:xyz' && oone(`SELECT track_id FROM track_external_id WHERE ext_id='xyz'`).track_id === 11
  && oone(`SELECT resolved_by FROM rec_item_playable WHERE run_id=101 AND rank=2`).resolved_by === 'client');
publishSnapshot(); const S2 = latestSnap(), s2 = new DatabaseSync(join(snapsDir, S2.path), { readOnly: true });
newRun(102, S2); addItem(102, 1, s2, 11); // canonical in S2 is 10
recordExternalIds(s2, 102, [{ rank: 1, provider: 'spotify', status: 'ok', extId: 'xyz', playUri: 'spotify:track:xyz' }]);
check('same-root conflict is reused: moved to the root and identity columns updated', (() => { const r = oone(`SELECT track_id, recording_mbid FROM track_external_id WHERE ext_id='xyz'`); return r.track_id === 10 && r.recording_mbid === 'm10'; })() && cachedId(s2, 10) === 'xyz');
odb.exec(`UPDATE track_external_id SET recording_mbid='m-other' WHERE ext_id='xyz'`);
check('cache row whose MBID does not match the snapshot track is ignored (searched again)', cachedId(s2, 10) === null);
odb.exec(`INSERT INTO track_external_id (track_id, recording_mbid, isrc, title_norm, provider, ext_id, market, method) VALUES (13, NULL, 'JPX9', 'v', 'spotify', 'q13', 'JP', 'x')`);
db.exec(`INSERT INTO track_isrc (isrc, track_id) VALUES ('JPX9',13)`); publishSnapshot(); const s3 = new DatabaseSync(join(snapsDir, latestSnap().path), { readOnly: true });
const okIsrc = cachedId(s3, 13); odb.exec(`UPDATE track_external_id SET title_norm='other' WHERE ext_id='q13'`);
check('MBID NULL: reused only when ISRC AND normalized title match', okIsrc === 'q13' && cachedId(s3, 13) === null);
odb.exec(`UPDATE track_external_id SET recording_mbid='m10' WHERE ext_id='xyz'`);
recordExternalIds(s2, 102, [{ rank: 1, provider: 'spotify', status: 'not_found' }]);
check('not_found rechecks for a valid ID in the same transaction', /already has an id/.test(log.at(-1)) && oone(`SELECT count(*) AS n FROM track_resolve_miss`).n === 0);
newRun(103, S2); addItem(103, 1, s2, 12);
recordExternalIds(s2, 103, [{ rank: 1, provider: 'spotify', status: 'not_found' }]);
const activeMiss = (snapDb, t) => { const id = identity(snapDb, t);
  return oall(`SELECT * FROM track_resolve_miss WHERE track_id=? AND provider='spotify' AND market='JP' AND next_try_at > ?`, t, now).some((r) => sameRecording(r, id)); };
const excluded = () => [10, 12].filter((t) => !cachedId(s2, t) && activeMiss(s2, t));
check('excluded only with no valid ID AND an active miss', JSON.stringify(excluded()) === '[12]');
odb.exec(`UPDATE track_resolve_miss SET recording_mbid='m-other' WHERE track_id=12`);
check('a miss whose identity does not match the snapshot track is ignored', excluded().length === 0);
odb.exec(`UPDATE track_resolve_miss SET recording_mbid='m12' WHERE track_id=12`);
recordExternalIds(s2, 103, [{ rank: 1, provider: 'spotify', status: 'ok', extId: 'abc', playUri: 'spotify:track:abc' }]);
check('ok write deletes the miss in the same transaction', excluded().length === 0 && oone(`SELECT count(*) AS n FROM track_resolve_miss`).n === 0);
let errRej = false; try { recordExternalIds(s2, 103, [{ rank: 1, provider: 'spotify', status: 'error' }]); } catch { errRej = true; }
check('429/network error is not recorded as a miss', errRej && oone(`SELECT count(*) AS n FROM track_resolve_miss`).n === 0);
check('cache writes never touch the main DB', db.prepare('SELECT total_changes() AS n').get().n - mainChangesBefore === 2 /* merge + dirty */ + 2 /* publish S2 */ + 1 /* track_isrc */ + 2 /* publish S3 */);
check('id_epoch equal: cache kept', epochCheck() === 'ok' && oone(`SELECT count(*) AS n FROM track_external_id`).n > 0);
db.exec(`UPDATE meta SET value='${randomUUID()}' WHERE key='id_epoch'`); // init / restore regenerates it
check('id_epoch mismatch: the whole online DB is reset in place (rec_* too), epoch recorded', epochCheck() === 'online DB reset' && oone(`SELECT (SELECT count(*) FROM track_external_id) + (SELECT count(*) FROM rec_run) + (SELECT count(*) FROM rec_item) AS n`).n === 0 && oone(`SELECT value FROM meta WHERE key='id_epoch'`).value === meta('id_epoch'));
s1.close(); s2.close(); s3.close();

// ---------- snapshots: latest and cleanup by id; explain() on a deleted snapshot; pin ----------
db.exec(`UPDATE snapshot SET created_at = created_at + 100000 WHERE id = (SELECT min(id) FROM snapshot)`); // clock went back for the newer ones
check('latest = ORDER BY id DESC even if the wall clock went back', latestSnap().id === one(`SELECT max(id) AS m FROM snapshot`).m);
function snapshotPin(id, label) { if (!label) throw new Error('label required'); return db.prepare(`UPDATE snapshot SET pinned=1, label=? WHERE id=?`).run(label, id).changes; }
const firstId = one(`SELECT min(id) AS m FROM snapshot`).m; snapshotPin(firstId, 'eval-2010');
function cleanupSnapshots(keep = 2) {
  const drop = all(`SELECT id, path FROM snapshot WHERE pinned = 0 AND id NOT IN (SELECT id FROM snapshot ORDER BY id DESC LIMIT ?)`, keep);
  for (const r of drop) { db.prepare(`DELETE FROM snapshot WHERE id=?`).run(r.id); try { unlinkSync(join(snapsDir, r.path)); } catch {} }
  return drop.map((r) => r.id); }
const before = all(`SELECT id FROM snapshot ORDER BY id`).map((r) => r.id); const dropped = cleanupSnapshots();
const kept = all(`SELECT id FROM snapshot ORDER BY id`).map((r) => r.id);
check('cleanup keeps pinned + latest 2 by id', kept.length === 3 && kept[0] === firstId && kept.at(-1) === before.at(-1) && dropped.length === before.length - 3);
newRun(101, S1); newRun(102, S2); // the epoch test above reset the online DB
const explain = (runId) => { const r = oone(`SELECT snapshot_id FROM rec_run WHERE id=?`, runId); return one(`SELECT 1 AS x FROM snapshot WHERE id=?`, r.snapshot_id) ? 'ok' : 'deleted'; };
check('explain() of a run whose snapshot was cleaned up returns "deleted"', dropped.includes(S1.id) && explain(101) === 'deleted' && explain(102) === 'ok');
const verifiedInProcess = new Set();
function openSnapshotForRead() { // newest-first over retained rows until one opens and verifies (SHA once per process)
  for (const r of all(`SELECT id, path, sha256 FROM snapshot ORDER BY id DESC`)) {
    const abs = join(snapsDir, r.path);
    try { if (!verifiedInProcess.has(r.id) && !snapshotOk(r)) continue; verifiedInProcess.add(r.id);
      return { id: r.id, d: openSnap(abs) }; } catch {} }
  return null; }
{ const rows = all(`SELECT id, path FROM snapshot ORDER BY id DESC`); const newest = rows[0];
  writeFileSync(join(snapsDir, newest.path), 'garbage'); // newest is corrupt
  const got = openSnapshotForRead(); const jm = got.d.prepare('PRAGMA journal_mode').get().journal_mode; got.d.close();
  check('reader scans newest-first and falls back to an older valid snapshot', got.id < newest.id && got.id === rows.find((r) => r.id !== newest.id && existsSync(join(snapsDir, r.path)) && readFileSync(join(snapsDir, r.path)).length > 100).id);
  check('read-only snapshot open does not switch to WAL (no -wal file)', jm !== 'wal' && !existsSync(join(snapsDir, rows.find((r) => r.id === got.id).path + '-wal')));
  db.exec(`UPDATE meta SET value='0' WHERE key='dirty'`);
  const res = refresh(four([0, 0, 0, 0]));
  check('refresh start validates snapshots: corrupt unpinned row removed, still-valid ones kept (no publish needed)', res === 'no change' && !one(`SELECT 1 AS x FROM snapshot WHERE id=?`, newest.id));
  for (const r of all(`SELECT path FROM snapshot WHERE pinned = 0`)) writeFileSync(join(snapsDir, r.path), 'garbage');
  const pinnedRow = one(`SELECT path FROM snapshot WHERE pinned = 1`); const pinnedBytes = readFileSync(join(snapsDir, pinnedRow.path));
  writeFileSync(join(snapsDir, pinnedRow.path), 'garbage');
  const res2 = refresh(four([0, 0, 0, 0]));
  check('no valid snapshot left: refresh publishes even with dirty=0; corrupt pinned row kept and reported', res2 === 'snapshot' && badPinned.length === 1 && one(`SELECT count(*) AS n FROM snapshot WHERE pinned = 1`).n === 1);
  writeFileSync(join(snapsDir, pinnedRow.path), pinnedBytes); }

// ---------- snapshot-pin: same lock, verifies the file before pinning ----------
function snapshotPinCmd(id, label) { const r0 = withLock('snapshot-pin', () => { const r = one(`SELECT id, path, sha256 FROM snapshot WHERE id=?`, id);
  if (!r || !snapshotOk(r)) return 'refused: snapshot missing or corrupt'; snapshotPin(id, label); return 'pinned'; }); return r0.locked ? 'locked' : r0.result; }
{ const latestId = latestSnap().id;
  const viaLock = withLock('refresh', () => snapshotPinCmd(latestId, 'x'));
  check('snapshot-pin takes djdb.lock (refused while a refresh holds it)', viaLock.result === 'locked' && one(`SELECT pinned FROM snapshot WHERE id=?`, latestId).pinned === 0);
  check('snapshot-pin pins a verified snapshot', snapshotPinCmd(latestId, 'eval-forward-2026') === 'pinned' && one(`SELECT pinned FROM snapshot WHERE id=?`, latestId).pinned === 1);
  db.exec(`UPDATE meta SET value='1' WHERE key='dirty'`); publishSnapshot(); const bad = latestSnap(); writeFileSync(join(snapsDir, bad.path), 'garbage');
  check('snapshot-pin refuses a corrupt snapshot', snapshotPinCmd(bad.id, 'x') === 'refused: snapshot missing or corrupt' && one(`SELECT pinned FROM snapshot WHERE id=?`, bad.id).pinned === 0); }

// ---------- online-reset: in place, one exclusive transaction, same file ----------
{ const ino = statSync(onlinePath).ino; const other = openDb(onlinePath); // another dj-mcp process keeps its connection
  newRun(201, latestSnap()); addItem(201, 1, db, 12);
  onlineReset();
  check('online-reset keeps the same file (no rename) and empties every online table, visible to an open connection', statSync(onlinePath).ino === ino
    && other.prepare(`SELECT (SELECT count(*) FROM rec_run) + (SELECT count(*) FROM rec_item) + (SELECT count(*) FROM track_external_id) AS n`).get().n === 0
    && other.prepare(`SELECT value FROM meta WHERE key='id_epoch'`).get().value === meta('id_epoch'));
  other.close(); }

// ---------- recommend(): reason for an empty discover ----------
function discoverCandidates(snapDb) { const n = snapDb.prepare(`SELECT count(*) AS n FROM fetch_cache WHERE endpoint='lb:top-recordings'`).get().n;
  if (n === 0) return { items: [], reason: 'no top-recordings cache and LB popularity looks paused; try djdb refresh later' }; return { items: ['…'] }; }
{ const got = openSnapshotForRead(); const r = discoverCandidates(got.d); got.d.close();
  check('discover with 0 candidates returns a reason', r.items.length === 0 && /popularity looks paused/.test(r.reason)); }

// ---------- online DB migration: BEGIN IMMEDIATE, re-read user_version, migrate, bump, COMMIT ----------
{ const p = join(root, 'mig.sqlite'); const a = openDb(p), b = openDb(p); let ran = 0;
  function migrateOnline(d) { d.exec('BEGIN IMMEDIATE'); try { const v = d.prepare('PRAGMA user_version').get().user_version;
      if (v < 1) { d.exec('CREATE TABLE t (x INTEGER) STRICT'); d.exec('PRAGMA user_version = 1'); ran++; } d.exec('COMMIT'); } catch (e) { d.exec('ROLLBACK'); throw e; } }
  const seenA = a.prepare('PRAGMA user_version').get().user_version, seenB = b.prepare('PRAGMA user_version').get().user_version; // both saw 0
  a.exec('BEGIN IMMEDIATE'); b.exec('PRAGMA busy_timeout=0'); let blocked = false; try { b.exec('BEGIN IMMEDIATE'); } catch { blocked = true; } a.exec('ROLLBACK');
  migrateOnline(a); migrateOnline(b);
  check('two dj-mcp processes: the second waits, re-reads user_version and does not migrate again', seenA === 0 && seenB === 0 && blocked && ran === 1 && b.prepare('PRAGMA user_version').get().user_version === 1);
  a.close(); b.close(); }

// ---------- name seeds ----------
db.exec(`INSERT INTO artist_alias (alias_norm, artist_id, source, norm_version) VALUES ('the a',2,'lb',1)`);
const seedByName = (n) => { const r = all(`SELECT DISTINCT artist_id FROM artist_alias WHERE alias_norm=?`, n); return r.length === 1 ? { artistId: r[0].artist_id } : { unresolved: r.length ? 'ambiguous' : 'not_found' }; };
check('name seed matching several aliases is returned unresolved as "ambiguous"', seedByName('the a').unresolved === 'ambiguous' && seedByName('zzz').unresolved === 'not_found');

// ---------- LB feedback: read-only signal mirrored by refresh; nothing in djdb/dj-mcp writes feedback anywhere ----------
function pullFeedback(pages) { // all pages fetched first; compare; replace in one transaction only if changed
  const rows = []; for (const p of pages) { if (p instanceof Error) return 'fetch failed: kept old set'; rows.push(...p); }
  const key = (r) => r.mbid ? `mbid:${r.mbid}` : `msid:${r.msid}`;
  const next = rows.map((r) => `${key(r)}|${r.score}|${r.created}`).sort(), cur = all(`SELECT recording_key || '|' || score || '|' || created AS k FROM lb_feedback`).map((r) => r.k).sort();
  if (JSON.stringify(next) === JSON.stringify(cur)) return 0;
  return batch(() => { db.exec('DELETE FROM lb_feedback');
    const ins = db.prepare(`INSERT INTO lb_feedback (recording_key, recording_mbid, recording_msid, score, created, track_id) VALUES (?,?,?,?,?,?)`);
    for (const r of rows) ins.run(key(r), r.mbid ?? null, r.msid ?? null, r.score, r.created, r.track_id ?? null);
    db.prepare(`INSERT INTO meta (key, value) VALUES ('lb_feedback_synced_at', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(now));
    return 1; });
}
const fbRows = [{ mbid: 'rec-love', score: 1, created: 1199145600, track_id: 10 }, { mbid: 'rec-hate', score: -1, created: now - 5, track_id: 13 }];
db.exec(`UPDATE meta SET value='0' WHERE key='dirty'`);
check('feedback pull with changes sets dirty', pullFeedback([fbRows.slice(0, 1), fbRows.slice(1)]) === 1 && meta('dirty') === '1');
db.exec(`UPDATE meta SET value='0' WHERE key='dirty'`);
check('identical feedback (compared before writing) does not set dirty', pullFeedback([fbRows]) === 0 && meta('dirty') === '0');
check('a failed page keeps the old set untouched', pullFeedback([fbRows.slice(0, 1), new Error('503')]) === 'fetch failed: kept old set' && one(`SELECT count(*) AS n FROM lb_feedback`).n === 2 && meta('dirty') === '0');
mustThrow('feedback score 0 is not stored (0 = removed on LB)', () => db.exec(`INSERT INTO lb_feedback (recording_key, recording_mbid, score, created) VALUES ('mbid:z','z',0,1)`));
mustThrow('feedback key without mbid:/msid: prefix', () => db.exec(`INSERT INTO lb_feedback (recording_key, recording_mbid, score, created) VALUES ('z','z',1,1)`));

// ---------- overlay: online = snapshot (incl. lb_feedback) + online DB (recent recs/events, ID cache); eval = snapshot only ----------
const snapId = publishSnapshot() && latestSnap();
const runIns = odb.prepare(`INSERT INTO rec_run (id, created_at, snapshot_id, snapshot_sha256, mode, algo_version, params_hash, params_json) VALUES (?,?,?,?,?,?,?,?)`);
runIns.run(1, now, snapId.id, snapId.sha256, 'discover', 'v9', 'h', '{}');
odb.exec(`INSERT INTO rec_item (run_id, rank, artist_id, track_id, title_norm, score) VALUES (1,1,1,10,'t',0.5),(1,2,1,12,'u',0.4);
  INSERT INTO rec_event (run_id, rank, kind, at) VALUES (1,1,'impression',${now});`);
odb.exec('BEGIN');
const hwm = oone(`SELECT (SELECT ifnull(max(id),0) FROM rec_run) AS prior_rec_run_max_id, (SELECT ifnull(max(id),0) FROM rec_event) AS rec_event_max_id`);
odb.exec('COMMIT');
runIns.run(2, now + 1, snapId.id, snapId.sha256, 'discover', 'v9', 'h', '{}');
odb.exec(`INSERT INTO rec_item (run_id, rank, artist_id, track_id, title_norm, score) VALUES (2,1,1,12,'u',0.5); INSERT INTO rec_event (run_id, rank, kind, at) VALUES (2,1,'queued',${now + 1});`);
const recentRows = odb.prepare(`SELECT DISTINCT ri.track_id FROM rec_item ri JOIN rec_run r ON r.id = ri.run_id
  WHERE r.id <= ? AND r.id < 100 AND r.created_at >= ?
    AND EXISTS (SELECT 1 FROM rec_event e WHERE e.run_id = ri.run_id AND e.rank = ri.rank AND e.kind IN ('impression','queued') AND e.id <= ?)
  ORDER BY 1`).all(hwm.prior_rec_run_max_id, now - 30 * DAY, hwm.rec_event_max_id).map((r) => r.track_id);
check('recent recommendations = exposed items of logged (online) runs within HWMs (unexposed rank 2 and later run 2 excluded)', JSON.stringify(recentRows) === '[10]');
check('two HWMs read in one online-DB read transaction', hwm.prior_rec_run_max_id === 1 && hwm.rec_event_max_id === 1);
const latest = latestSnap().path;
const snap = new DatabaseSync(join(snapsDir, latest), { readOnly: true });
const snapFeedback = snap.prepare(`SELECT track_id, score FROM lb_feedback`).all();
const onlineHated = snap.prepare(`SELECT track_id FROM lb_feedback WHERE score = -1`).all().map((r) => r.track_id);
const evalLoves = snap.prepare(`SELECT track_id FROM lb_feedback WHERE score = 1 AND created < ?`).all(1262304000).map((r) => r.track_id);
const snapHasLog = snap.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE name IN ('rec_run','rec_event','track_external_id')`).get().n;
let snapWrite = false; try { snap.exec('DELETE FROM play'); } catch { snapWrite = true; }
snap.close();
check('feedback has one source per run (the snapshot): a love counts once, the existing hate excludes its recording', snapFeedback.filter((r) => r.track_id === 10 && r.score === 1).length === 1 && JSON.stringify(onlineHated) === '[13]');
check('snapshot contains no log or ID cache (they live in the online DB)', snapHasLog === 0);
check('eval reads the snapshot only, feedback with created < cutoff_at', JSON.stringify(evalLoves) === '[10]' && snapWrite);

// ---------- remaining constraints ----------
mustThrow('same source_key, different via', () => db.exec(`INSERT INTO play (source_key, origin, origin_version, via, via_version, played_at, raw_artist, raw_title) VALUES ('lb:1000|m1','spotify',1,'lb:spotify',1,1000,'A','T')`));
mustThrow('dup keeps match columns', () => db.exec(`INSERT INTO play (source_key, origin, origin_version, via, via_version, played_at, raw_artist, raw_title, track_id, canonical_play_id) VALUES ('lb:1010|m2','spotify',1,'lb:spotify',1,1010,'A','T',10,100)`));
db.exec(`INSERT INTO play (id, source_key, origin, origin_version, via, via_version, played_at, raw_artist, raw_title, canonical_play_id) VALUES (101,'lb:1010|m2','spotify',1,'lb:spotify',1,1010,'A','T',100)`);
mustThrow('multi-hop canonical on insert', () => db.exec(`INSERT INTO play (source_key, origin, origin_version, via, via_version, played_at, raw_artist, raw_title, canonical_play_id) VALUES ('lb:1020|m3','spotify',1,'lb:web',1,1020,'A','T',101)`));
mustThrow('snapshot absolute path', () => db.exec(`INSERT INTO snapshot (created_at, path, sha256, user_version) VALUES (1,'/x.db','${'a'.repeat(64)}',1)`));
mustThrow('ext_id as URI', () => odb.exec(`INSERT INTO track_external_id (track_id, recording_mbid, title_norm, provider, ext_id, market, method) VALUES (12,'m12','u','spotify','spotify:track:q','JP','x')`), odb);
mustThrow('miss next_try_at not after tried_at', () => odb.exec(`INSERT INTO track_resolve_miss (track_id, recording_mbid, title_norm, provider, market, tried_at, next_try_at) VALUES (12,'m12','u','spotify','US',5,5)`), odb);
mustThrow('cache row without MBID or ISRC (identity cannot be checked)', () => odb.exec(`INSERT INTO track_external_id (track_id, title_norm, provider, ext_id, market, method) VALUES (12,'u','spotify','q2','JP','x')`), odb);
mustThrow('rec_event deferred kind', () => odb.exec(`INSERT INTO rec_event (run_id, rank, kind, at) VALUES (1,1,'qualified_listen',1)`), odb);
mustThrow('playable bad resolved_by', () => odb.exec(`INSERT INTO rec_item_playable (run_id, rank, provider, ext_id, market, resolved_by, resolved_at) VALUES (1,1,'spotify','xyz','JP','labs',1)`), odb);
mustThrow('rec_run bad snapshot sha256', () => odb.exec(`INSERT INTO rec_run (created_at, snapshot_id, snapshot_sha256, mode, algo_version, params_hash, params_json) VALUES (1,1,'abc','discover','v9','h','{}')`), odb);
for (const t of ['feedback', 'track_external_id', 'track_resolve_miss', 'rec_run', 'rec_event', 'artist_external_id', 'generation', 'job_lock'])
  if (one(`SELECT count(*) AS n FROM sqlite_master WHERE name=?`, t).n) fail('main DB still has ' + t);
checks++; console.log('CHECK_OK: main DB has no feedback/ID cache/log tables');

// ---------- canonical_play_id UPDATE: root check in the dedup code path (no extra trigger) ----------
function setCanonical(dupId, rootId) { db.exec('BEGIN IMMEDIATE');
  try { if (!one(`SELECT 1 AS x FROM play WHERE id=? AND canonical_play_id IS NULL`, rootId)) throw new Error('target is not a root');
    if (one(`SELECT 1 AS x FROM play WHERE canonical_play_id=?`, dupId)) throw new Error('play has duplicates; cannot demote');
    db.prepare(`UPDATE play SET canonical_play_id=?, track_id=NULL WHERE id=?`).run(rootId, dupId); db.exec('COMMIT'); return 'ok'; }
  catch (e) { db.exec('ROLLBACK'); return e.message; } }
db.exec(`INSERT INTO play (id, source_key, origin, origin_version, via, via_version, played_at, raw_artist, raw_title) VALUES (102,'lb:1030|m4','spotify',1,'lb:web',1,1030,'A','T')`);
check('canonical_play_id UPDATE: pointing at a non-root is refused', setCanonical(102, 101) === 'target is not a root');
check('canonical_play_id UPDATE: demoting a root that has duplicates is refused', setCanonical(100, 102) === 'play has duplicates; cannot demote');
check('canonical_play_id UPDATE to a root is accepted', setCanonical(102, 100) === 'ok');

// ---------- online DB: stale run ids after a reset, concurrent auto-reset ----------
{ newRun(401, latestSnap()); addItem(401, 1, db, 12); const stale = 401;
  const msg = onlineReset();
  check('online-reset tells the user to restart running dj-mcp processes', /restart/.test(msg));
  const fresh = Number(odb.prepare(`INSERT INTO rec_run (created_at, snapshot_id, snapshot_sha256, mode, algo_version, params_hash, params_json) VALUES (?,?,?,?,?,?,?)`).run(now, latestSnap().id, latestSnap().sha256, 'discover', 'v11', 'h', '{}').lastInsertRowid);
  check('AUTOINCREMENT rec_run: a reset never hands out an old run id again', fresh > stale);
  const r1 = recordExternalIds(null, stale, [{ rank: 1, provider: 'spotify', status: 'ok', extId: 'zz', playUri: 'spotify:track:zz' }]), r2 = recordEvent(stale, 1, 'impression');
  check('stale runId after a reset: recordExternalIds/recordEvent write nothing and return an error', r1.error === 'unknown_run' && r2.error === 'unknown_run'
    && oone(`SELECT (SELECT count(*) FROM track_external_id) + (SELECT count(*) FROM rec_event) AS n`).n === 0);
  // two dj-mcp processes both saw an epoch mismatch; A resets and writes, then B's reset must not wipe A's write
  const a = openDb(onlinePath), b = openDb(onlinePath);
  setMeta('id_epoch', randomUUID());
  const aSaw = a.prepare(`SELECT value FROM meta WHERE key='id_epoch'`).get().value !== meta('id_epoch'), bSaw = b.prepare(`SELECT value FROM meta WHERE key='id_epoch'`).get().value !== meta('id_epoch');
  onlineReset(a, { onlyIfEpochDiffers: true });
  a.prepare(`INSERT INTO rec_run (created_at, snapshot_id, snapshot_sha256, mode, algo_version, params_hash, params_json) VALUES (?,?,?,?,?,?,?)`).run(now, 1, 'a'.repeat(64), 'discover', 'v11', 'h', '{}');
  const bRes = onlineReset(b, { onlyIfEpochDiffers: true });
  check('concurrent auto-reset: the second process re-reads id_epoch inside BEGIN EXCLUSIVE and keeps the first one\'s write', aSaw && bSaw && bRes === 'already reset' && oone(`SELECT count(*) AS n FROM rec_run`).n === 1);
  a.close(); b.close(); }

// ---------- refresh fallback when nothing valid exists and a stage fails; eval refuses a corrupt pin ----------
{ for (const r of all(`SELECT path FROM snapshot`)) writeFileSync(join(snapsDir, r.path), 'garbage');
  const res = refresh([{ name: 'lb-sync', ok: false }]);
  check('no valid snapshot + failed stage (LB down): one snapshot still taken from the batch-consistent main DB, noted for status(), dirty kept', /fallback snapshot/.test(res) && meta('dirty') === '1' && /lb-sync failed/.test(meta('refresh_note')) && openSnapshotForRead() !== null);
  const pin = one(`SELECT id, path, sha256 FROM snapshot WHERE pinned = 1`);
  const evalRun = (id) => { const r = one(`SELECT id, path, sha256 FROM snapshot WHERE id=? AND pinned = 1`, id); return r && snapshotOk(r) ? 'ok' : `eval stopped: pinned snapshot ${id} failed the SHA check`; };
  check('eval stops with a reason when a pinned snapshot fails its SHA check', /eval stopped/.test(evalRun(pin.id)));
  const got = openSnapshotForRead(); const abs = join(snapsDir, one(`SELECT path FROM snapshot WHERE id=?`, got.id).path); got.d.prepare('SELECT count(*) AS n FROM track').get(); got.d.close();
  check('snapshot files are journal_mode=DELETE and immutable reads leave no -wal/-shm', !existsSync(abs + '-wal') && !existsSync(abs + '-shm')); }

// ---------- djdb restore <file>: VACUUM INTO temp, prepare, verify, then backup() onto the live DB in place ----------
async function withLockAsync(command, fn) { const token = randomUUID(); let fd;
  try { fd = openSync(lockPath, 'wx'); } catch (e) { if (e.code === 'EEXIST') return { locked: true }; throw e; }
  try { writeSync(fd, JSON.stringify({ pid: process.pid, token, command, started_at: now })); closeSync(fd); return { result: await fn() }; }
  finally { try { const cur = JSON.parse(readFileSync(lockPath, 'utf8')); if (cur.pid === process.pid && cur.token === token) unlinkSync(lockPath); } catch {} } }
async function restore(src, { crashBeforeApply = false } = {}) {
  return (await withLockAsync('restore', async () => {
    for (const f of readdirSync(root)) if (f.startsWith('djdb.sqlite.restore-')) unlinkSync(join(root, f)); // leftovers of a crashed restore
    const s0 = new DatabaseSync(src, { readOnly: true }); const uv = s0.prepare('PRAGMA user_version').get().user_version;
    const key = s0.prepare(`SELECT value FROM meta WHERE key='lb_account_key'`).get()?.value;
    if (uv < LIB_USER_VERSION.min || uv > LIB_USER_VERSION.max || key !== meta('lb_account_key')) { s0.close(); return 'refused'; }
    const aside = join(root, `before-restore-${now}-${randomUUID().slice(0, 8)}`); mkdirSync(join(aside, 'snapshots'), { recursive: true });
    db.exec(`VACUUM INTO '${join(aside, 'djdb.sqlite')}'`); // backup of the current DB, not a file copy
    for (const r of all(`SELECT path FROM snapshot`)) try { linkSync(join(snapsDir, r.path), join(aside, 'snapshots', r.path)); } catch {} // immutable files: hard links
    const tmp = join(root, `djdb.sqlite.restore-${randomUUID()}`);
    s0.exec(`VACUUM INTO '${tmp}'`); s0.close();
    const t = new DatabaseSync(tmp);
    t.exec('BEGIN'); t.exec('DELETE FROM snapshot'); t.prepare(`UPDATE meta SET value=? WHERE key='id_epoch'`).run(randomUUID()); t.exec(`UPDATE meta SET value='1' WHERE key='dirty'`); t.exec('COMMIT');
    const ok = t.prepare('PRAGMA integrity_check').get().integrity_check === 'ok';
    if (!ok) { t.close(); unlinkSync(tmp); return 'refused: integrity'; }
    if (crashBeforeApply) { t.close(); return 'crashed'; }
    await sqliteBackup(t, dbPath); t.close(); unlinkSync(tmp); // in place: consistent with open connections and the WAL
    onlineReset();
    return aside; })).result;
}
{ const backupFile = join(root, 'backup.sqlite'); db.exec(`VACUUM INTO '${backupFile}'`);
  const oldEpoch = meta('id_epoch');
  db.exec(`INSERT INTO track (title, title_norm, norm_version, artist_credit) VALUES ('after','after',1,'A')`); // newer data that the restore rolls back
  const before = { epoch: meta('id_epoch'), tracks: one(`SELECT count(*) AS n FROM track`).n };
  check('restore crash before the apply step leaves the live DB untouched', await restore(backupFile, { crashBeforeApply: true }) === 'crashed'
    && meta('id_epoch') === before.epoch && one(`SELECT count(*) AS n FROM track`).n === before.tracks && readdirSync(root).some((f) => f.startsWith('djdb.sqlite.restore-')));
  const reader = openDb(dbPath); reader.prepare(`SELECT count(*) AS n FROM track`).get(); // a dj-mcp connection stays open
  const ino = statSync(dbPath).ino;
  newRun(501, latestSnap()); addItem(501, 1, db, 12);
  const aside = await restore(backupFile);
  check('restore applies in place (same file, open connection sees the restored DB, WAL kept)', statSync(dbPath).ino === ino
    && !reader.prepare(`SELECT 1 AS x FROM track WHERE title='after'`).get() && !one(`SELECT 1 AS x FROM track WHERE title='after'`) && one('PRAGMA journal_mode').journal_mode === 'wal');
  check('restore: crashed temp file cleaned, current DB backed up via VACUUM INTO with snapshot files', !readdirSync(root).some((f) => f.startsWith('djdb.sqlite.restore-'))
    && new DatabaseSync(join(aside, 'djdb.sqlite'), { readOnly: true }).prepare(`SELECT count(*) AS n FROM track WHERE title='after'`).get().n === 1 && readdirSync(join(aside, 'snapshots')).length > 0);
  check('restore: new id_epoch, dirty=1, no snapshot rows, whole online DB reset', meta('id_epoch') !== oldEpoch && meta('dirty') === '1' && one(`SELECT count(*) AS n FROM snapshot`).n === 0
    && oone(`SELECT count(*) AS n FROM rec_run`).n === 0 && oone(`SELECT value FROM meta WHERE key='id_epoch'`).value === meta('id_epoch'));
  check('restore: the following refresh publishes a new snapshot', refresh(four([0, 0, 0, 0])) === 'snapshot' && one(`SELECT count(*) AS n FROM snapshot`).n === 1);
  reader.close();
  writeFileSync(join(root, 'other.sqlite'), ''); const o = new DatabaseSync(join(root, 'other.sqlite')); o.exec(SCHEMA); o.exec(`INSERT INTO meta (key, value) VALUES ('lb_account_key','someone-else')`); o.close();
  check('restore refuses a DB of another account', await restore(join(root, 'other.sqlite')) === 'refused'); }

for (const [name, d] of [['MAIN', db], ['ONLINE', odb]]) console.log(name, 'FK_CHECK', d.prepare('PRAGMA foreign_key_check').all().length, 'INTEGRITY', d.prepare('PRAGMA integrity_check').get().integrity_check);
db.close(); odb.close(); rmSync(root, { recursive: true });
console.log(`VALIDATION_OK rejects=${rejects} checks=${checks}`);
