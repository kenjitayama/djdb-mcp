// Constraints in sql/schema.sql and sql/schema-online.sql, run against the real DDL.
// Each rejected statement has an accepted twin, so a pass means that one constraint fired.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initMainSchema, initOnlineSchema, userVersion, LIB_USER_VERSION } from '../lib/db.mjs';

function fresh() {
  const main = new DatabaseSync(':memory:');
  const online = new DatabaseSync(':memory:');
  main.exec('PRAGMA foreign_keys=ON');
  online.exec('PRAGMA foreign_keys=ON');
  initMainSchema(main);
  initOnlineSchema(online);
  main.exec(`
    INSERT INTO artist (id, name) VALUES (1, 'A');
    INSERT INTO track (id, title, title_norm, norm_version, artist_credit) VALUES (10, 'T', 't', 1, 'A'), (12, 'U', 'u', 1, 'A');
    INSERT INTO play (id, source_key, origin, origin_version, via, via_version, played_at, raw_artist, raw_title, raw_json)
      VALUES (100, 'lb:1000|m1', 'spotify', 1, 'lb:lastfm', 1, 1000, 'A', 'T', '{"v":1}');
    INSERT INTO play (id, source_key, origin, origin_version, via, via_version, played_at, raw_artist, raw_title, canonical_play_id)
      VALUES (101, 'lb:1010|m2', 'spotify', 1, 'lb:spotify', 1, 1010, 'A', 'T', 100);
  `);
  online.exec(`
    INSERT INTO rec_run (id, created_at, snapshot_id, snapshot_sha256, mode, algo_version, params_hash, params_json)
      VALUES (1, 1, 1, '${'a'.repeat(64)}', 'discover', 'v11', 'h', '{}');
    INSERT INTO rec_item (run_id, rank, artist_id, track_id, title_norm, score) VALUES (1, 1, 1, 12, 'u', 0.5);
  `);
  return { main, online };
}

const MAIN = 'main';
const ONLINE = 'online';

// [label, db, rejected statement, accepted twin]
const cases = [
  ['play raw_json is immutable', MAIN,
    `UPDATE play SET raw_json='{}' WHERE id=100`,
    `UPDATE play SET lb_recording_mbid='m', lb_mapping_at=1 WHERE id=100`],
  ['play source_key is immutable', MAIN,
    `UPDATE play SET source_key='lb:2|x' WHERE id=100`,
    `UPDATE play SET via='lb:web' WHERE id=100`],
  ['the same source_key twice, even with another via', MAIN,
    `INSERT INTO play (source_key, origin, origin_version, via, via_version, played_at, raw_artist, raw_title) VALUES ('lb:1000|m1','spotify',1,'lb:spotify',1,1000,'A','T')`,
    `INSERT INTO play (source_key, origin, origin_version, via, via_version, played_at, raw_artist, raw_title) VALUES ('lb:1000|m9','spotify',1,'lb:spotify',1,1000,'A','T')`],
  ['a duplicate play keeps no match columns', MAIN,
    `INSERT INTO play (source_key, origin, origin_version, via, via_version, played_at, raw_artist, raw_title, track_id, canonical_play_id) VALUES ('lb:1020|m3','spotify',1,'lb:web',1,1020,'A','T',10,100)`,
    `INSERT INTO play (source_key, origin, origin_version, via, via_version, played_at, raw_artist, raw_title, canonical_play_id) VALUES ('lb:1020|m3','spotify',1,'lb:web',1,1020,'A','T',100)`],
  ['a duplicate play points straight at a root', MAIN,
    `INSERT INTO play (source_key, origin, origin_version, via, via_version, played_at, raw_artist, raw_title, canonical_play_id) VALUES ('lb:1030|m4','spotify',1,'lb:web',1,1030,'A','T',101)`,
    `INSERT INTO play (source_key, origin, origin_version, via, via_version, played_at, raw_artist, raw_title, canonical_play_id) VALUES ('lb:1030|m4','spotify',1,'lb:web',1,1030,'A','T',100)`],
  ['feedback score 0 is not stored (0 means removed on LB)', MAIN,
    `INSERT INTO lb_feedback (recording_key, recording_mbid, score, created) VALUES ('mbid:z','z',0,1)`,
    `INSERT INTO lb_feedback (recording_key, recording_mbid, score, created) VALUES ('mbid:z','z',-1,1)`],
  ['feedback key needs an mbid: or msid: prefix', MAIN,
    `INSERT INTO lb_feedback (recording_key, recording_mbid, score, created) VALUES ('z','z',1,1)`,
    `INSERT INTO lb_feedback (recording_key, recording_msid, score, created) VALUES ('msid:z','z',1,1)`],
  ['a track does not merge into itself', MAIN,
    `UPDATE track SET merged_into=10 WHERE id=10`,
    `UPDATE track SET merged_into=10 WHERE id=12`],
  ['a pinned snapshot needs a label', MAIN,
    `INSERT INTO snapshot (created_at, path, sha256, user_version, pinned) VALUES (1,'s.db','${'a'.repeat(64)}',1,1)`,
    `INSERT INTO snapshot (created_at, path, sha256, user_version, pinned, label) VALUES (1,'s.db','${'a'.repeat(64)}',1,1,'eval')`],
  ['a snapshot path stays under snapshots/', MAIN,
    `INSERT INTO snapshot (created_at, path, sha256, user_version) VALUES (1,'/x.db','${'a'.repeat(64)}',1)`,
    `INSERT INTO snapshot (created_at, path, sha256, user_version) VALUES (1,'x.db','${'a'.repeat(64)}',1)`],
  ['ext_id is a bare ID, not a URI', ONLINE,
    `INSERT INTO track_external_id (track_id, recording_mbid, title_norm, provider, ext_id, market, method) VALUES (12,'m12','u','spotify','spotify:track:q','JP','x')`,
    `INSERT INTO track_external_id (track_id, recording_mbid, title_norm, provider, ext_id, market, method) VALUES (12,'m12','u','spotify','q','JP','x')`],
  ['a cache row carries an MBID or an ISRC', ONLINE,
    `INSERT INTO track_external_id (track_id, title_norm, provider, ext_id, market, method) VALUES (12,'u','spotify','q2','JP','x')`,
    `INSERT INTO track_external_id (track_id, isrc, title_norm, provider, ext_id, market, method) VALUES (12,'JPX1','u','spotify','q2','JP','x')`],
  ['a miss is retried strictly after it was tried', ONLINE,
    `INSERT INTO track_resolve_miss (track_id, recording_mbid, title_norm, provider, market, tried_at, next_try_at) VALUES (12,'m12','u','spotify','US',5,5)`,
    `INSERT INTO track_resolve_miss (track_id, recording_mbid, title_norm, provider, market, tried_at, next_try_at) VALUES (12,'m12','u','spotify','US',5,6)`],
  ['rec_event kinds are impression and queued only', ONLINE,
    `INSERT INTO rec_event (run_id, rank, kind, at) VALUES (1,1,'qualified_listen',1)`,
    `INSERT INTO rec_event (run_id, rank, kind, at) VALUES (1,1,'queued',1)`],
  ['a playable row is resolved by cache or client', ONLINE,
    `INSERT INTO rec_item_playable (run_id, rank, provider, ext_id, market, resolved_by, resolved_at) VALUES (1,1,'spotify','xyz','JP','labs',1)`,
    `INSERT INTO rec_item_playable (run_id, rank, provider, ext_id, market, resolved_by, resolved_at) VALUES (1,1,'spotify','xyz','JP','client',1)`],
  ['rec_run snapshot_sha256 is 64 hex characters', ONLINE,
    `INSERT INTO rec_run (created_at, snapshot_id, snapshot_sha256, mode, algo_version, params_hash, params_json) VALUES (1,1,'abc','discover','v11','h','{}')`,
    `INSERT INTO rec_run (created_at, snapshot_id, snapshot_sha256, mode, algo_version, params_hash, params_json) VALUES (1,1,'${'b'.repeat(64)}','discover','v11','h','{}')`],
];

for (const [label, which, bad, good] of cases) {
  test(`schema rejects: ${label}`, () => {
    const dbs = fresh();
    const d = dbs[which];
    assert.throws(() => d.exec(bad), /constraint|immutable|root play/i);
    assert.doesNotThrow(() => d.exec(good));
  });
}

test('both schemas carry the library user_version and pass integrity and foreign key checks', () => {
  const { main, online } = fresh();
  for (const d of [main, online]) {
    assert.equal(userVersion(d), LIB_USER_VERSION.max);
    assert.equal(d.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(d.prepare('PRAGMA foreign_key_check').all(), []);
  }
});

test('the main DB holds no feedback-writing, ID cache, or log tables', () => {
  const { main } = fresh();
  const names = main.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name);
  for (const t of ['feedback', 'track_external_id', 'track_resolve_miss', 'rec_run', 'rec_item', 'rec_event', 'artist_external_id', 'generation', 'job_lock']) {
    assert.ok(!names.includes(t), t);
  }
});
