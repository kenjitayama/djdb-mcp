-- Online DB (djdb-online.sqlite, next to the main DB). Written only by the online path inside dj-mcp:
-- recommend(), recordEvent(), recordExternalIds(). Never written by refresh.
-- track_id / artist_id are main-DB ids.
PRAGMA foreign_keys = ON;

-- main_db_key = the main DB's lb_account_key, set when a fresh online DB is first opened for writing.
-- On mismatch (another main DB) recommend is disabled and nothing is deleted. `djdb online-reset --yes`
-- empties every table in place (one BEGIN EXCLUSIVE on the same file, no rename) and rebinds.
-- Migrated on open for writing: BEGIN IMMEDIATE, re-read user_version, migrate, bump, COMMIT.
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- Spotify ID cache. Reused only if the main DB's track still matches: recording_mbid equal, or (mbid NULL)
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
  PRIMARY KEY (provider, market, ext_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX track_external_id_t ON track_external_id(track_id, provider, market);

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

-- Online runs only.
CREATE TABLE rec_run (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,  -- resets never clear sqlite_sequence: run ids are never reused
  created_at      INTEGER NOT NULL,
  mode            TEXT NOT NULL CHECK (mode IN ('discover','rediscover')),
  algo_version    TEXT NOT NULL,
  params_hash     TEXT NOT NULL,
  params_json     TEXT NOT NULL
) STRICT;
CREATE INDEX rec_run_time ON rec_run(created_at);

CREATE TABLE rec_item (
  run_id           INTEGER NOT NULL REFERENCES rec_run(id),
  rank             INTEGER NOT NULL,
  pre_rank         INTEGER,
  candidate_source TEXT,
  artist_id        INTEGER NOT NULL,
  track_id         INTEGER NOT NULL,
  recording_mbid   TEXT,
  isrc             TEXT,
  title_norm       TEXT NOT NULL,
  score            REAL NOT NULL,
  components_json  TEXT,
  -- Where it can be played: from the ID cache at recommend time, or the first ID dj-mcp reports for this run.
  provider         TEXT,
  ext_id           TEXT CHECK (instr(ext_id, ':') = 0 AND instr(ext_id, '/') = 0),
  play_uri         TEXT,
  market           TEXT,
  resolved_by      TEXT CHECK (resolved_by IN ('cache','client')),
  resolved_at      INTEGER,
  CHECK ((ext_id IS NULL) = (provider IS NULL) AND (ext_id IS NULL) = (market IS NULL)
     AND (ext_id IS NULL) = (resolved_by IS NULL) AND (ext_id IS NULL) = (resolved_at IS NULL)),
  PRIMARY KEY (run_id, rank)
) STRICT;
CREATE INDEX rec_item_track ON rec_item(track_id);

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

PRAGMA user_version = 2;
