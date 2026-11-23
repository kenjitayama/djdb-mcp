-- Online DB (djdb-online.sqlite, next to the main DB). Written only by the online path inside dj-mcp:
-- recommend(), recordEvent(), recordExternalIds(). Never written by refresh and never snapshotted.
-- track_id / artist_id are main-DB ids; readers follow main-DB merged_into before using them.
PRAGMA foreign_keys = ON;

-- main_db_key = the main DB's lb_account_key (mismatch: other main DB, recommend disabled; `djdb online-reset`).
-- id_epoch = the main DB's id_epoch. On mismatch, and on `djdb online-reset`, every table here is emptied in place
-- (one BEGIN EXCLUSIVE on the same file, no rename).
-- Migrated in open(): BEGIN IMMEDIATE, re-read user_version, migrate, bump, COMMIT.
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- Spotify ID cache. Reused only if the snapshot's track still matches: recording_mbid equal, or (mbid NULL)
-- isrc among the track's ISRCs AND title_norm equal. Otherwise ignored and searched again.
CREATE TABLE track_external_id (
  track_id       INTEGER NOT NULL,
  recording_mbid TEXT,
  isrc           TEXT,
  title_norm     TEXT NOT NULL,
  provider    TEXT NOT NULL,
  ext_id      TEXT NOT NULL CHECK (instr(ext_id, ':') = 0 AND instr(ext_id, '/') = 0),
  play_uri    TEXT,
  market      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','unavailable','wrong')),
  method      TEXT NOT NULL,
  verified_at INTEGER,
  CHECK (recording_mbid IS NOT NULL OR isrc IS NOT NULL),
  PRIMARY KEY (provider, ext_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX track_external_id_t ON track_external_id(track_id, provider);

-- Negative cache: only a successful search with 0 results. next_try_at = tried_at + 30 days.
CREATE TABLE track_resolve_miss (
  track_id       INTEGER NOT NULL,
  recording_mbid TEXT,
  isrc           TEXT,
  title_norm     TEXT NOT NULL,
  provider    TEXT NOT NULL,
  market      TEXT NOT NULL,
  tried_at    INTEGER NOT NULL,
  next_try_at INTEGER NOT NULL,
  PRIMARY KEY (track_id, provider, market),
  CHECK (next_try_at > tried_at),
  CHECK (recording_mbid IS NOT NULL OR isrc IS NOT NULL)
) STRICT, WITHOUT ROWID;

-- Online runs only (eval results go to eval/*.json). fetched_json keeps the LB Radio / top-recordings
-- responses used by the run.
CREATE TABLE rec_run (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,  -- resets never clear sqlite_sequence: run ids are never reused
  created_at      INTEGER NOT NULL,
  snapshot_id     INTEGER NOT NULL,
  snapshot_sha256 TEXT NOT NULL CHECK (length(snapshot_sha256) = 64),
  mode            TEXT NOT NULL CHECK (mode IN ('discover','rediscover')),
  algo_version    TEXT NOT NULL,
  params_hash     TEXT NOT NULL,
  params_json     TEXT NOT NULL,
  fetched_json    TEXT
) STRICT;
CREATE INDEX rec_run_time ON rec_run(created_at);

CREATE TABLE rec_item (
  run_id           INTEGER NOT NULL REFERENCES rec_run(id),
  rank             INTEGER NOT NULL,
  pre_rank         INTEGER,
  candidate_source TEXT,
  artist_id        INTEGER NOT NULL,
  track_id         INTEGER NOT NULL,  -- canonical in this run's snapshot
  recording_mbid   TEXT,
  isrc             TEXT,
  title_norm       TEXT NOT NULL,
  score            REAL NOT NULL,
  components_json  TEXT,
  PRIMARY KEY (run_id, rank)
) STRICT;
CREATE INDEX rec_item_track ON rec_item(track_id);

CREATE TABLE rec_item_playable (
  run_id      INTEGER NOT NULL,
  rank        INTEGER NOT NULL,
  provider    TEXT NOT NULL,
  ext_id      TEXT NOT NULL CHECK (instr(ext_id, ':') = 0 AND instr(ext_id, '/') = 0),
  play_uri    TEXT,
  market      TEXT NOT NULL,
  resolved_by TEXT NOT NULL CHECK (resolved_by IN ('cache','client')),
  resolved_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, rank, provider),
  FOREIGN KEY (run_id, rank) REFERENCES rec_item(run_id, rank)
) STRICT;

-- Exposures only for now; attribution is derived later from these rows plus LB plays.
CREATE TABLE rec_event (
  id       INTEGER PRIMARY KEY,
  run_id   INTEGER NOT NULL,
  rank     INTEGER NOT NULL,
  kind     TEXT NOT NULL CHECK (kind IN ('impression','queued')),
  at       INTEGER NOT NULL,
  provider TEXT,
  FOREIGN KEY (run_id, rank) REFERENCES rec_item(run_id, rank)
) STRICT;
CREATE INDEX rec_event_item ON rec_event(run_id, rank, at);

PRAGMA user_version = 1;
