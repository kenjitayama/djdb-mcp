---
name: djdb
description: Inspect a personal ListenBrainz-backed music library and preview recommendations with the djdb-mcp tools — status (with library counts), recommend (MBID/ISRC only), and explain. Use when asked what the local djdb library contains, whether a refresh is needed, or for a discover/rediscover preview. Writes (init, refresh) go through the djdb CLI, not these tools.
---

# djdb-mcp (library + recommender)

The tools come from the `djdb-mcp` MCP server. Agents that can't load MCP servers can use `djdb status --json` instead. Maintenance uses the CLI:

`node <path-to-@kenjitayama/djdb-mcp>/bin/djdb <command>`

When the package is installed under dj-mcp:

`node <dj-mcp>/node_modules/@kenjitayama/djdb-mcp/bin/djdb <command>`

or `npm exec --prefix <dj-mcp> --no -- djdb <command>`.

It prints JSON with `--json`. A failed command exits 1 and prints `{"error":{code,message,hint}}`. `status` always prints its report and exits 1 when `ok` is false; read `reason` and `hint` there.

## Before anything
- `no database`: the user must run `djdb init` (ListenBrainz token via `LISTENBRAINZ_TOKEN`) then `djdb refresh --export <dir>` with the extracted ListenBrainz export folder (`user.json` and `listens/`). Later refreshes are incremental.
- `never refreshed`: run `djdb refresh`. `schema_too_old`: the database is from djdb 0.1; follow the hint to rebuild.
- 暫定 in `status`: the last refresh stopped early or some ListenBrainz requests failed; results use what was fetched before. Run `djdb refresh` again later.
- `stale lock`: show the pid and time from `djdb status`. `djdb unlock` removes it only if that pid is gone.
- `online_db_mismatch`: recommend is disabled; suggest `djdb online-reset --yes` once the user agrees.
- Never print the ListenBrainz token. Never submit listens or feedback to ListenBrainz from this package.

## What to call
- Health / "is the library ready?" → `status` (or `djdb status --json`).
- Counts of plays, artists, tracks → `status` (the `counts` field).
- "Recommend something" → `recommend` with `mode` and optional `n`, `seeds`. `discover` finds recordings the user has not played; `rediscover` brings back artists from an earlier era. The standalone server returns recording MBIDs and ISRCs only and does not record the run. Playback IDs are dj-mcp's job.
- Explain a run that dj-mcp recorded → `explain { run_id }`.

## Rules
- Report only what the tools return. Don't invent listens, charts, or recommendations.
- This server does not start Spotify playback and does not write the online DB.
- Do not tell the user to invoke a bare unscoped `djdb` binary from a public registry.
