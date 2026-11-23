# @kenjitayama/djdb-mcp

A personal ListenBrainz-backed music library and recommender. It stores plays, matching, an artist graph, and popularity in SQLite, and recommends recordings (MBID / ISRC) by reading the main DB read-only.

Three entry points, zero runtime dependencies (`node:sqlite` and `fetch` only). Not affiliated with or endorsed by ListenBrainz or MetaBrainz.

- **Library (ESM)** — what [dj-mcp](https://github.com/kenjitayama/dj-mcp) imports.
- **CLI** (`bin/djdb`) — `init`, `refresh`, `status`, and the other maintenance commands.
- **MCP server** (`bin/djdb-mcp-server`) — a standalone, read-oriented server for lookups. It returns recording MBIDs and ISRCs only (it has no Spotify credentials) and opens the run log (`djdb-online.sqlite`, called the online DB in the code and CLI) read-only, so it never records recommendation runs. The run log is a local SQLite file next to the main DB. It records recommendation runs, the playback IDs found per market, and which tracks were shown or queued.

dj-mcp remains the user-facing playback client. It works without this package; it just doesn't offer `recommend`.

## Purpose

Public music APIs give a new app little to build personal recommendations on.

- Spotify removed Recommendations and Related Artists, among other endpoints, for new and development-mode Web API apps on [2024-11-27](https://developer.spotify.com/blog/2024-11-27-changes-to-the-web-api).
- ListenBrainz computes personal recommendations in batches: daily and weekly playlists, and [collaborative-filtering recommendations](https://listenbrainz.readthedocs.io/en/latest/users/api/recommendation.html) with a `last_updated` time. LB Radio builds playlists on demand from a prompt, but its personal inputs (your statistics and recommendations) are batch results too.

djdb-mcp keeps your own listening history in a local database and gives AI agents an on-demand recommender built on it. ListenBrainz stays its only data source: your listens and feedback, plus similar artists and popularity.

## Requirements

- Node `>=24.15.0 <25 || >=26 <27` (checked at runtime). dj-mcp itself stays on `>=20`; it disables the recommender on an unsupported Node rather than breaking playback.
- A [ListenBrainz](https://listenbrainz.org/) account and user token (Settings → MusicBrainz account / user token). This package never submits listens or feedback to ListenBrainz.

## Install

This package is not published to npm. dj-mcp pins one git tag in its `optionalDependencies`:

```json
"optionalDependencies": {
  "@kenjitayama/djdb-mcp": "github:kenjitayama/djdb-mcp#v0.2.1"
}
```

Then, only if you want recommendations:

```
npm install --omit=dev
```

Do not auto-install the optional dependency.

## CLI

Always invoke the binary by path, or through `npm exec` scoped to the install:

```
node <path-to-@kenjitayama/djdb-mcp>/bin/djdb <command>
```

When this package is installed under dj-mcp:

```
node <dj-mcp>/node_modules/@kenjitayama/djdb-mcp/bin/djdb <command>
npm exec --prefix <dj-mcp> --no -- djdb <command>
```

Commands:

| Command | What it does |
|---|---|
| `djdb init` | Create the databases and bind them to one ListenBrainz account. Token from `LISTENBRAINZ_TOKEN` or the token file. |
| `djdb refresh` | Lock, sync, match, build the graph and popularity. This is the usual way data changes. First sync: `--export <dir>`. Later syncs use `/listens` deltas. `--listens-full-history` pages the whole history only when an export is unavailable. |
| `djdb status` | Lock (reported only: a running refresh does not stop recommend), last refresh and whether it was incomplete (marked provisional; `provisional: true` in `--json`), library counts. `--json` available. |
| `djdb account-rename <name>` | After a ListenBrainz username change. The token must belong to `<name>`. |
| `djdb unlock` | Delete `djdb.lock` if the process that holds it is gone. A running holder keeps it (exit 1). |
| `djdb online-reset --yes` | Empty the run log in place. Without `--yes` nothing changes. Restart running dj-mcp processes afterwards. |

No command prompts. `--db <path>` overrides the main database path. `djdb refresh --export <dir>` passes a ListenBrainz export: download the ZIP from ListenBrainz, extract it, and pass the folder that holds `user.json` and `listens/`. The export must belong to the initialized account. If an import stops midway, run the same command again; it finishes without duplicates. `--listens-full-history` is the explicit opt-in to page the entire history through `GET /1/user/{user}/listens` when no export is available.

### Where files live

- Main DB path: `DJDB_PATH` → `~/.config/djdb-mcp/config.json` `dbPath` → `${XDG_DATA_HOME:-~/.local/share}/djdb-mcp/djdb.sqlite`
- The run log `djdb-online.sqlite` and `djdb.lock` sit next to the main DB.
- ListenBrainz token file: `~/.config/djdb-mcp/lb-token.json` (mode `0600`). Never commit this file. Example only (placeholder values, never a real token):

```json
{
  "token": "YOUR_LISTENBRAINZ_TOKEN"
}
```

  There is no `--token` flag, so the token never lands in `ps` output or shell history.

### Init

1. Create a ListenBrainz user token on listenbrainz.org.
2. `LISTENBRAINZ_TOKEN=YOUR_LISTENBRAINZ_TOKEN node <path>/bin/djdb init`. Init checks the token with ListenBrainz and saves it to the token file (mode `0600`), so later commands do not need the variable. Init refuses to run over an existing database, and a failed init leaves no database behind.
3. Import your past listening history into ListenBrainz first (for example from Last.fm or a Spotify data export) so there is enough data. This tool only *reads* ListenBrainz. Then request a listens export on ListenBrainz, download the ZIP, and extract it.
4. `node <path>/bin/djdb refresh --export <extracted-export-dir>`
5. Later refreshes are incremental (`/listens` with `min_ts` and a one-hour overlap). `node <path>/bin/djdb status`

### Two things a delta refresh does not see

- **Listens added later with old timestamps.** A delta refresh asks only for listens newer than the last one it has. If you import older history into ListenBrainz after your first refresh (for example a Spotify ZIP), request a new export and run `djdb refresh --export <new-export-dir>`. Plays already in djdb are not duplicated.
- **Deletions.** A listen you delete on ListenBrainz stays in djdb. To drop it, rebuild: move the data directory aside, then `djdb init` and `djdb refresh --export <dir>`.

## MCP server

Generic stdio (newline-delimited JSON-RPC 2.0):

```json
{
  "mcpServers": {
    "djdb-mcp": {
      "command": "node",
      "args": ["<path-to-@kenjitayama/djdb-mcp>/bin/djdb-mcp-server"],
      "env": {}
    }
  }
}
```

Optional: set `DJDB_PATH` if the database is not in the default location. Tools: `status` (including library counts), `recommend` (preview, no writes), `explain`.

## Library API

Semver (0.x: minor versions may break) covers these functions and their return shapes:

```js
import {
  API_VERSION,          // 2
  NODE_RANGE,
  nodeSupported,
  resolveDbPath,
  openReader,
  status,
  recommend,
  recordExternalIds,
  recordEvent,
  explain,
  normalizeTitle,       // the same normalization djdb uses for title_norm,
  normalizeArtist,      // so dj-mcp can check a Spotify match against an item
} from '@kenjitayama/djdb-mcp';
```

Nothing else in `lib/` is public.

- `recommend(handle, { mode, n, provider, market, seeds, record, cutoffAt })`. `mode` is `discover` or `rediscover` (see below). `record: false` is a dry run that writes nothing (the standalone MCP server uses it). A recorded run and its items are written in one transaction. Seeds are `{ mbid }` or `{ name }`. A seed with a name and a Spotify URI resolves by the name; a seed with only a URI comes back in `unresolved` with `uri_not_resolved`.
- `recordExternalIds(online, runId, items, { market })` stores the playback IDs dj-mcp found for a run's items. The ID cache is per market: an ID found for `JP` is not served for `US`. An item with neither a recording MBID nor an ISRC is not cached (hit or miss); its play target is still stored on the run.
- `recordEvent(online, runId, rank, kind)`. If `runId` is missing or unknown, nothing is written and `{ error: 'unknown_run' }` is returned (non-fatal for dj-mcp).
- `explain(online, runId)` returns the run's parameters and items.

`openReader({ online: 'write' })` opens the main DB read-only, creates and migrates the run log if needed (`BEGIN IMMEDIATE` → re-read `user_version` → migrate → bump → COMMIT), and binds a fresh one to the main DB's `lb_account_key`. A run log bound to another main DB is never emptied automatically: `recommend()` returns `disabled` with `online_db_mismatch` until you run `djdb online-reset --yes`. `openReader({ online: 'read' })` never creates the run log.

## How refresh works

Under one lock file (`djdb.lock`, deleted only by its creator):

1. Check the schema version. A djdb 0.1 database (schema v1) is refused with `schema_too_old`: move the data directory aside and rebuild with `djdb init` and `djdb refresh --export <dir>`.
2. `lb-sync` — first run imports a ListenBrainz export (`--export`); later runs fetch only new listens from `GET /1/user/{user}/listens` with `min_ts` set a small overlap before the last fetched `listened_at`. `UNIQUE(source_key)` absorbs the overlap. Paging the whole history through `/listens` happens only with `--listens-full-history`. Love/hate feedback is also pulled here; if that fetch fails, the old set stays and the stage is `partial`.
3. `match`: recordings in this order: MBID → ISRC → normalized name. An MBID that arrives later attaches to the artist or track first matched by name or ISRC. Then a 60-second cross-via dedup safety net, which never merges two plays whose MBIDs or ISRCs differ. A play without an MBID may also match by name a track with an MBID that you have played, never a catalog-only one. A pair whose plays ListenBrainz later maps to different MBIDs is split again, and a changed mapping clears the play's match until this stage runs. `lb_feedback.track_id` is re-attached via MBID at the end of this stage.
4. `graph`: ListenBrainz similar-artists for every played artist with an MBID, stored as `lb:similar-artists:<algorithm>`. A similar artist you have never played is added as a catalog artist (alias source `lb:catalog`). Catalog artists are graph destinations only, and a play is never matched to one by name.
5. `popularity`: ListenBrainz artist popularity and top recordings for played artists and the 300 catalog artists most strongly linked from them. The first 10 top recordings of each are cached and added as tracks, which is where discover finds recordings you have not heard.
6. Write `refreshed_at` and `refresh_note`.

`graph` and `popularity` commit each ListenBrainz response to `fetch_cache` as it arrives, then rebuild their tables from the cache in one transaction. A request that fails keeps the old cached response. A 2xx whose body is not JSON, or not the shape of that endpoint, is a failed request (`lb_bad_response`) and nothing is written from it. Each stage commits, and readers read the main DB inside one read transaction, so `recommend()` always sees a committed state. A failed stage stops the run and leaves earlier stages in place. A stage with failed requests finishes as `partial`. Either way `status()` marks the library provisional until a complete refresh.

## Recommend modes

- `discover`: recordings you have not played, from artists near your taste in the graph who are not among your heaviest. A recording you played before the cutoff is skipped, and so is the same song under another recording (same primary artist and normalized title).
- `rediscover`: artists you played heavily in an earlier era and barely play now. Their top recordings, or else your own most played tracks by them.

Both modes count only plays and love/hate feedback from before `cutoffAt` (default: now), and recommend one recording per artist.

## Algorithm parameters (provisional)

`recommend()` uses `DEFAULT_PARAMS` in `lib/recommend.mjs`. These values are **provisional** and will be tuned after evaluation. The design fixes some of them (α in 0.3–0.5, top 3 recordings, 180-day era gap, 30-day overlay and miss window); the rest (`beta`, `rho`, `kappa`, `T`, heavy `q`/`m`, and so on) are starting points, not finals. Current starting values: `alpha=0.4`, `beta=0.5`, `rho=0.6`, `kappa=10`, `T=365 days`, `q=20`, `m=3`.

Listens without a ListenBrainz `recording_msid` use `source_key = lb:<listened_at>|nomssid:<hex>`, where `<hex>` is the first 32 hex characters of SHA-256 over `<listened_at>|<normalizeArtist(artist)>|<normalizeTitle(track)>|<normalizeTitle(release)>`.

## Development

```
npm test   # node --test test/*.test.mjs (includes the schema tests)
```

Live ListenBrainz verification is pending (the account is not usable yet). Stages that talk to ListenBrainz are covered with fixtures and mocks.

## License

MIT, © 2026 Kenji Tayama.
