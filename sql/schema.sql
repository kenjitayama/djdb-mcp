PRAGMA foreign_keys = ON;

-- Main DB: written ONLY by `djdb refresh` (plus `djdb init` / `djdb account-rename`, which touch meta only).
-- meta keys: lb_account_key (local, never changes), id_epoch (new UUID on init), lb_user,
-- dirty (0/1, set in the same transaction as each refresh batch that changed rows), lb_feedback_synced_at
-- artist / track rows are never deleted, only merged; AUTOINCREMENT so an id is never reused.
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE artist (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  mbid        TEXT UNIQUE,
  merged_into INTEGER REFERENCES artist(id),
  CHECK (merged_into IS NULL OR merged_into <> id)
) STRICT;
CREATE TABLE artist_alias (
  alias_norm   TEXT NOT NULL,
  artist_id    INTEGER NOT NULL REFERENCES artist(id),
  source       TEXT NOT NULL,
  norm_version INTEGER NOT NULL,
  PRIMARY KEY (alias_norm, artist_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE track (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  title              TEXT NOT NULL,
  title_norm         TEXT NOT NULL,
  norm_version       INTEGER NOT NULL,
  artist_credit      TEXT NOT NULL,
  mbid               TEXT UNIQUE,
  version_kind       TEXT,
  first_release_date TEXT,
  release_group_type TEXT,
  duration_ms        INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  merged_into        INTEGER REFERENCES track(id),
  CHECK (merged_into IS NULL OR merged_into <> id)
) STRICT;
CREATE TABLE track_artist (
  track_id    INTEGER NOT NULL REFERENCES track(id),
  position    INTEGER NOT NULL,
  artist_id   INTEGER NOT NULL REFERENCES artist(id),
  join_phrase TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (track_id, position)
) STRICT, WITHOUT ROWID;
CREATE INDEX track_artist_a ON track_artist(artist_id);
CREATE TABLE track_isrc (
  isrc     TEXT NOT NULL,
  track_id INTEGER NOT NULL REFERENCES track(id),
  PRIMARY KEY (isrc, track_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX track_isrc_t ON track_isrc(track_id);

CREATE TABLE play (
  id                       INTEGER PRIMARY KEY,
  source_key               TEXT NOT NULL UNIQUE CHECK (source_key GLOB 'lb:[0-9]*|?*'),
  origin                   TEXT NOT NULL,
  origin_version           INTEGER NOT NULL,
  via                      TEXT NOT NULL,
  via_version              INTEGER NOT NULL,
  played_at                INTEGER NOT NULL,
  ts_quality               TEXT NOT NULL DEFAULT 'ok' CHECK (ts_quality IN ('ok','batch')),
  raw_artist               TEXT NOT NULL,
  raw_title                TEXT NOT NULL,
  raw_album                TEXT,
  raw_duration_ms          INTEGER,
  submitted_recording_mbid TEXT,
  raw_ext_id               TEXT,
  raw_isrc                 TEXT,
  raw_json                 TEXT,
  lb_recording_mbid        TEXT,
  lb_mapping_at            INTEGER,
  artist_id                INTEGER REFERENCES artist(id),
  track_id                 INTEGER REFERENCES track(id),
  match_method             TEXT,
  match_version            INTEGER,
  matched_at               INTEGER,
  canonical_play_id        INTEGER REFERENCES play(id),
  CHECK (canonical_play_id IS NULL OR canonical_play_id <> id),
  CHECK (
    canonical_play_id IS NULL
    OR (
      artist_id IS NULL AND track_id IS NULL
      AND match_method IS NULL AND match_version IS NULL AND matched_at IS NULL
    )
  )
) STRICT;
CREATE INDEX play_time ON play(played_at);
CREATE INDEX play_track ON play(track_id, played_at);
CREATE INDEX play_artist ON play(artist_id, played_at);
CREATE INDEX play_unmatched ON play(match_version) WHERE track_id IS NULL;
CREATE INDEX play_canon ON play(played_at, track_id) WHERE canonical_play_id IS NULL;
CREATE INDEX play_canon_of ON play(canonical_play_id) WHERE canonical_play_id IS NOT NULL;

-- Only first-observed fields are immutable; lb_recording_mbid / lb_mapping_at, via/origin, played_at and match columns may change.
CREATE TRIGGER play_raw_immutable
BEFORE UPDATE OF source_key, raw_artist, raw_title, raw_album, raw_json, submitted_recording_mbid ON play
FOR EACH ROW
WHEN NEW.source_key IS NOT OLD.source_key
  OR NEW.raw_artist IS NOT OLD.raw_artist
  OR NEW.raw_title IS NOT OLD.raw_title
  OR NEW.raw_album IS NOT OLD.raw_album
  OR NEW.raw_json IS NOT OLD.raw_json
  OR NEW.submitted_recording_mbid IS NOT OLD.submitted_recording_mbid
BEGIN
  SELECT RAISE(ABORT, 'play source_key and first-observed raw fields are immutable');
END;

-- A duplicate must point directly at a root (INSERT: trigger; UPDATE: checked in the dedup code, same transaction).
CREATE TRIGGER play_canon_insert
BEFORE INSERT ON play
FOR EACH ROW
WHEN NEW.canonical_play_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'canonical_play_id must point to a root play')
  WHERE NOT EXISTS (
    SELECT 1 FROM play
    WHERE id = NEW.canonical_play_id AND canonical_play_id IS NULL
  );
END;

CREATE TABLE artist_popularity (
  artist_id    INTEGER NOT NULL REFERENCES artist(id),
  source       TEXT NOT NULL,
  user_count   INTEGER CHECK (user_count IS NULL OR user_count >= 0),
  listen_count INTEGER CHECK (listen_count IS NULL OR listen_count >= 0),
  fetched_at   INTEGER NOT NULL,
  PRIMARY KEY (artist_id, source)
) STRICT, WITHOUT ROWID;

-- source: 'lb:similar-artists:<algorithm>' (the only graph source for now)
CREATE TABLE edge (
  src        INTEGER NOT NULL REFERENCES artist(id),
  dst        INTEGER NOT NULL REFERENCES artist(id),
  source     TEXT NOT NULL,
  rank       INTEGER,
  raw        REAL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (source, src, dst),
  CHECK (src <> dst)
) STRICT, WITHOUT ROWID;
CREATE INDEX edge_dst ON edge(dst, source);

-- Read-only mirror of the user's existing ListenBrainz recording feedback (love = +1, hate = -1; includes
-- Last.fm Loved if LB's Last.fm import brought them). Fully replaced by each refresh. Nothing writes feedback
-- anywhere in phase 1; recommend() reads it from the snapshot only.
CREATE TABLE lb_feedback (
  recording_key  TEXT PRIMARY KEY CHECK (recording_key GLOB 'mbid:?*' OR recording_key GLOB 'msid:?*'),
  recording_mbid TEXT,
  recording_msid TEXT,
  score          INTEGER NOT NULL CHECK (score IN (1, -1)),
  created        INTEGER NOT NULL,
  track_id       INTEGER REFERENCES track(id),
  CHECK (recording_mbid IS NOT NULL OR recording_msid IS NOT NULL)
) STRICT, WITHOUT ROWID;
CREATE INDEX lb_feedback_track ON lb_feedback(track_id) WHERE track_id IS NOT NULL;

-- Refresh-time HTTP cache only (similar artists, popularity, top recordings). recommend() makes no network calls.
CREATE TABLE fetch_cache (
  endpoint      TEXT NOT NULL,
  key           TEXT NOT NULL,
  status        INTEGER NOT NULL,
  body          TEXT,
  fetched_at    INTEGER NOT NULL,
  next_fetch_at INTEGER NOT NULL,
  PRIMARY KEY (endpoint, key)
) STRICT, WITHOUT ROWID;

-- Latest = ORDER BY id DESC (created_at is for display only). Only `djdb refresh` creates snapshots: VACUUM INTO a unique path, verify, then INSERT this row + dirty=0 in one commit.
-- The file is set to journal_mode=DELETE before hashing; readers open it read-only with immutable=1 (no -wal/-shm).
-- refresh start checks rows newest-first (file, sha256, quick_check): corrupt unpinned rows are deleted, corrupt pinned
-- rows are reported. Files in snapshots/ without a row are deleted at the next refresh start.
CREATE TABLE snapshot (
  id           INTEGER PRIMARY KEY,
  created_at   INTEGER NOT NULL,
  path         TEXT NOT NULL UNIQUE CHECK (substr(path, 1, 1) <> '/' AND instr(path, '..') = 0),
  sha256       TEXT NOT NULL CHECK (length(sha256) = 64),
  user_version INTEGER NOT NULL CHECK (user_version > 0),
  pinned       INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  label        TEXT,
  CHECK (pinned = 0 OR label IS NOT NULL)
) STRICT;

PRAGMA user_version = 1;
