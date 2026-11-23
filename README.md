# @kenjitayama/djdb-mcp

A personal ListenBrainz-backed music library and recommender. It stores plays, matching, an artist graph, and popularity in SQLite, and recommends recordings (MBID / ISRC) by reading the main DB read-only.

Three entry points, zero runtime dependencies (`node:sqlite` and `fetch` only). Not affiliated with or endorsed by ListenBrainz or MetaBrainz.

- **Library (ESM)** — what [dj-mcp](https://github.com/kenjitayama/dj-mcp) imports.
- **CLI** (`bin/djdb`) — `init`, `refresh`, `status`, and the other maintenance commands.
- **MCP server** (`bin/djdb-mcp-server`) — a standalone, read-oriented server for lookups. It returns recording MBIDs and ISRCs only (it has no Spotify credentials) and opens the online DB read-only, so it never records recommendation runs.

dj-mcp remains the user-facing playback client. If this package is not installed, dj-mcp behaves exactly as it does today.

## Requirements

- Node `>=24.15.0 <25 || >=26 <27` (checked at runtime). dj-mcp itself stays on `>=20`; it disables the recommender on an unsupported Node rather than breaking playback.
- A [ListenBrainz](https://listenbrainz.org/) account and user token (Settings → MusicBrainz account / user token). This package never submits listens or feedback to ListenBrainz.

## Install

Until a provenance publish of `@kenjitayama/djdb-mcp` is decided, pin a single git tag from dj-mcp's `optionalDependencies`:

```json
"optionalDependencies": {
  "@kenjitayama/djdb-mcp": "github:kenjitayama/djdb-mcp#v0.1.0"
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
| `djdb status` | Lock, last refresh and whether it stopped early (暫定), library counts. `--json` available. |
| `djdb account-rename <name>` | After a ListenBrainz username change. The token must belong to `<name>`. |
| `djdb unlock` | Delete `djdb.lock` if the process that holds it is gone. A running holder keeps it (exit 1). |
| `djdb online-reset --yes` | Empty the online DB in place. Without `--yes` nothing changes. Restart running dj-mcp processes afterwards. |

No command prompts. `--db <path>` overrides the main database path. `djdb refresh --export <dir>` passes a ListenBrainz export: download the ZIP from ListenBrainz, extract it, and pass the folder that holds `user.json` and `listens/`. The export must belong to the initialized account. If an import stops midway, run the same command again; it finishes without duplicates. `--listens-full-history` is the explicit opt-in to page the entire history through `GET /1/user/{user}/listens` when no export is available.

### Where files live

- Main DB path: `DJDB_PATH` → `~/.config/djdb-mcp/config.json` `dbPath` → `${XDG_DATA_HOME:-~/.local/share}/djdb-mcp/djdb.sqlite`
- Online DB `djdb-online.sqlite` and `djdb.lock` sit next to the main DB.
- ListenBrainz token file: `~/.config/djdb-mcp/lb-token.json` (mode `0600`). Never commit this file. Example only (placeholder values, never a real token):

```json
{
  "token": "YOUR_LISTENBRAINZ_TOKEN"
}
```

  There is no `--token` flag, so the token never lands in `ps` output or shell history.

### Init

1. Create a ListenBrainz token on listenbrainz.org.
2. `LISTENBRAINZ_TOKEN=YOUR_LISTENBRAINZ_TOKEN node <path>/bin/djdb init`
3. Import your history into ListenBrainz first (Last.fm import, then a Spotify export for gaps). This tool only *reads* ListenBrainz. Then download a ListenBrainz listens export and extract the JSON.
4. `node <path>/bin/djdb refresh --export <extracted-export-dir>`
5. Later refreshes are incremental (`/listens` with `min_ts` and a small overlap). `node <path>/bin/djdb status`

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
  API_VERSION,          // 1
  resolveDbPath,
  openReader,
  status,
  recommend,
  recordExternalIds,
  recordEvent,
  explain,
} from '@kenjitayama/djdb-mcp';
```

- `recommend({ mode, n, provider, market, seeds, record })` — `mode` is `discover` or `rediscover`. Pass `record: false` for a dry run (used by the standalone MCP server). Seeds are `{ mbid }` or `{ name }`; Spotify artist URIs must be resolved to a name by dj-mcp first.
- `recordEvent(online, runId, rank, kind)` — if `runId` is missing or unknown, nothing is written and `{ error: 'unknown_run' }` is returned (non-fatal for dj-mcp).
- `explain(online, runId)` — the run's parameters and items.

`openReader({ online: 'write' })` opens the main DB read-only, creates and migrates the online DB if needed (`BEGIN IMMEDIATE` → re-read `user_version` → migrate → bump → COMMIT), and binds a fresh one to the main DB's `lb_account_key`. An online DB bound to another main DB is never emptied automatically: `recommend()` returns `disabled` with `online_db_mismatch` until you run `djdb online-reset --yes`. `openReader({ online: 'read' })` never creates the online DB.

## How refresh works

Under one lock file (`djdb.lock`, deleted only by its creator):

1. Check the schema version. A djdb 0.1 database (schema v1) is refused with `schema_too_old`: move the data directory aside and rebuild with `djdb init` and `djdb refresh --export <dir>`.
2. `lb-sync` — first run imports a ListenBrainz export (`--export`); later runs fetch only new listens from `GET /1/user/{user}/listens` with `min_ts` set a small overlap before the last fetched `listened_at`. `UNIQUE(source_key)` absorbs the overlap. Paging the whole history through `/listens` happens only with `--listens-full-history`. Love/hate feedback is also pulled here.
3. `match` — recordings in this order: MBID → ISRC → normalized name. Then a 60-second cross-via dedup safety net. `lb_feedback.track_id` is re-attached via MBID at the end of this stage.
4. `graph` — ListenBrainz similar-artists, stored as `lb:similar-artists:<algorithm>`.
5. `popularity` — ListenBrainz artist popularity and top recordings (cached in `fetch_cache`).
6. Write `refreshed_at` and `refresh_note`.

Each stage commits in batches, and readers read the main DB inside one read transaction, so `recommend()` always sees a committed state. A failed stage stops the run and leaves earlier stages in place. `status()` then labels the library 暫定 (provisional) until a refresh succeeds.

## Algorithm parameters (暫定 / provisional)

`recommend()` uses `DEFAULT_PARAMS` in `lib/recommend.mjs`. These values are **暫定 / provisional** and will be tuned after evaluation. The design fixes some of them (α in 0.3–0.5, top 3 recordings, 180-day era gap, 30-day overlay and miss window); the rest (`beta`, `rho`, `kappa`, `T`, heavy `q`/`m`, and so on) are starting points, not finals. Current starting values: `alpha=0.4`, `beta=0.5`, `rho=0.6`, `kappa=10`, `T=365 days`, `q=20`, `m=3`.

Listens without a ListenBrainz `recording_msid` use `source_key = lb:<listened_at>|nomssid:<hex>`, where `<hex>` is the first 32 hex characters of SHA-256 over `<listened_at>|<normalizeArtist(artist)>|<normalizeTitle(track)>|<normalizeTitle(release)>`.

## Development

```
npm test   # node --test test/*.test.mjs (includes the schema tests)
```

Live ListenBrainz verification is pending (the account is not usable yet). Stages that talk to ListenBrainz are covered with fixtures and mocks.

## License

MIT, © 2026 Kenji Tayama.
