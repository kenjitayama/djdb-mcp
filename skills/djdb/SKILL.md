---
name: djdb
description: Inspect a personal ListenBrainz-backed music library and preview recommendations with the djdb-mcp tools — status, library stats, recommend (MBID/ISRC only), and explain. Use when asked what the local djdb library contains, whether a refresh is needed, or for a discover/rediscover preview. Writes (init, refresh, restore) go through the djdb CLI, not these tools.
---

# djdb-mcp (library + recommender)

The tools come from the `djdb-mcp` MCP server. Agents that can't load MCP servers can call the same read-oriented tools through status of the CLI, or recommend only after a snapshot exists. Maintenance uses the CLI:

`node <path-to-@kenjitayama/djdb-mcp>/bin/djdb <command>`

When the package is installed under dj-mcp:

`node <dj-mcp>/node_modules/@kenjitayama/djdb-mcp/bin/djdb <command>`

or `npm exec --prefix <dj-mcp> --no -- djdb <command>`.

It prints JSON with `--json`; on failure it exits 1 and prints `{"error":{code,message,hint}}`.

## Before anything
- `no database`: the user must run `djdb init` (ListenBrainz token via `LISTENBRAINZ_TOKEN`) then `djdb refresh --export <listenbrainz-export.json>`. Later refreshes are incremental.
- `no snapshot` / `schema changed`: run `djdb refresh`.
- `stale lock`: show the pid and time from `djdb status`. `djdb unlock` removes it only if that pid is gone.
- `main_db_key mismatch`: recommend is disabled; suggest `djdb online-reset --yes` once the user agrees.
- Never print the ListenBrainz token. Never submit listens or feedback to ListenBrainz from this package.

## What to call
- Health / "is the library ready?" → `status` (or `djdb status --json`).
- Counts of plays, artists, tracks → `status` (the `counts` field).
- "Recommend something" / discover vs. rediscover → `recommend` with `mode` and optional `n`, `seeds`. The standalone server returns recording MBIDs and ISRCs only and does not record the run. Playback IDs are dj-mcp's job.
- Explain a run that dj-mcp recorded → `explain { run_id }`. `status: "deleted"` means the snapshot was cleaned up.

## Rules
- Report only what the tools return. Don't invent listens, charts, or recommendations.
- This server does not start Spotify playback and does not write the online DB.
- Do not tell the user to invoke a bare unscoped `djdb` binary from a public registry.
