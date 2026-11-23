# @kenjitayama/djdb-mcp

A personal ListenBrainz-backed music library and recommender. It stores plays, matching, an artist graph, and popularity in SQLite, and recommends recordings (MBID / ISRC) from a read-only snapshot.

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
| `djdb refresh` | Lock, sync, match, build the graph and popularity, then publish a snapshot. This is the usual way data changes. |
| `djdb status` | Lock, dirty flag, latest snapshot, provisional snapshots, library counts. `--json` available. |
| `djdb account-rename <name>` | After a ListenBrainz username change, and only with a matching token plus confirmation. |
| `djdb unlock --force` | Show the lock holder and delete the lock after confirmation. |
| `djdb snapshot-pin <id> <label>` | Pin a verified snapshot (for later evaluation). |
| `djdb restore <file>` | Restore a backup in place (`backup()`, not a file rename). Then refresh to publish a new snapshot. |
| `djdb online-reset` | Empty the online DB in place after confirmation. Restart running dj-mcp processes afterwards. |

Add `--yes` to skip confirmation prompts in scripts. `--db <path>` overrides the main database path.

### Where files live

- Main DB path: `DJDB_PATH` → `~/.config/djdb-mcp/config.json` `dbPath` → `${XDG_DATA_HOME:-~/.local/share}/djdb-mcp/djdb.sqlite`
- Online DB `djdb-online.sqlite` and `snapshots/` sit next to the main DB.
- ListenBrainz token file: `~/.config/djdb-mcp/lb-token.json` (mode `0600`). It also stores the unchanging `lb_account_key`. Never commit this file. The path is not in the v11 design text; this is the implementation choice (see VERIFY.md).

### Init

1. Create a ListenBrainz token on listenbrainz.org.
2. `LISTENBRAINZ_TOKEN=… node <path>/bin/djdb init`
3. Import your history into ListenBrainz first (Last.fm import, then a Spotify export for gaps). This tool only *reads* ListenBrainz.
4. `node <path>/bin/djdb refresh`
5. `node <path>/bin/djdb status`

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

Optional: set `DJDB_PATH` if the database is not in the default location. Tools: `status`, `recommend` (preview, no writes), `explain`, `library_stats`.

## Library API

Semver (0.x: minor versions may break) covers these functions and their return shapes:

```js
import {
  API_VERSION,          // 1
  resolveDbPath,
  open,
  status,
  recommend,
  recordExternalIds,
  recordEvent,
  explain,
} from '@kenjitayama/djdb-mcp';
```

- `recommend({ mode, n, provider, market, randomSeed, seeds, record })` — `mode` is `discover` or `rediscover`. Pass `record: false` for a dry run (used by the standalone MCP server). Seeds are `{ mbid }` or `{ name }`; Spotify artist URIs must be resolved to a name by dj-mcp first.
- `recordEvent(online, runId, rank, kind)` — if `runId` is missing or unknown, nothing is written and `{ error: 'unknown_run' }` is returned (non-fatal for dj-mcp).
- `explain(online, main, runId)` — `{ status: 'deleted' }` if the run's snapshot was cleaned up.

`open()` migrates the online DB (`BEGIN IMMEDIATE` → re-read `user_version` → migrate → bump → COMMIT) and, on an `id_epoch` mismatch, resets the online DB in place against the **live** main DB's epoch.

## How refresh works

Under one lock file (`djdb.lock`, deleted only by its creator):

1. Migrate the main DB, delete leftovers, verify snapshots (file, SHA-256, `quick_check`).
2. `lb-sync` — listens and love/hate feedback from ListenBrainz.
3. `match` — recordings (MBID / ISRC / name) and a 60-second cross-via dedup safety net.
4. `graph` — ListenBrainz similar-artists, stored as `lb:similar-artists:<algorithm>`.
5. `popularity` — ListenBrainz artist popularity and top recordings (cached in the snapshot).
6. If anything changed, or no valid snapshot remains, `VACUUM INTO` a new snapshot, `journal_mode=DELETE`, verify, then register it and clear `dirty` in one commit.

A stage failure when no valid snapshot remains still takes one snapshot from the batch-consistent main DB and `status()` labels it 暫定 (provisional).

## Development

```
npm test            # node --test test/*.test.mjs
npm run test:schema # validate-schema.mjs (VALIDATION_OK rejects=16 checks=75)
```

Live ListenBrainz verification is pending (the account is not usable yet). Stages that talk to ListenBrainz are covered with fixtures and mocks.

## License

MIT, © 2026 Kenji Tayama.
