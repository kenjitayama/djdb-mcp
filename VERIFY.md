# Verification checklist

## Automated

- `npm test` (or `node --test test/*.test.mjs`) passes, including the schema tests and the stdio MCP smoke test.
- Docs never suggest invoking the CLI via a bare unscoped name from a public registry.
- Tracked files contain no tokens, Client IDs, device names, personal usernames, or machine-local absolute paths.

## Node

- Runtime and `engines` are `>=24.15.0 <25 || >=26 <27`.
- On an out-of-range Node, binaries exit 2 with a clear message; dj-mcp (engines `>=20`) must keep working and only disable the recommender.

## Init / token

- `LISTENBRAINZ_TOKEN` or the token file is required. The token file is `~/.config/djdb-mcp/lb-token.json`, mode `0600`, and holds only `token`. There is no `--token` flag. Docs show only placeholder values such as `YOUR_LISTENBRAINZ_TOKEN`.
- The CLI and MCP server never print the token.
- A username mismatch during `refresh` tells you to run `djdb account-rename`.

## Listen sync
- First sync requires `--export <dir>` (or `LISTENBRAINZ_EXPORT`), the extracted export with `user.json` and `listens/<year>/<month>.jsonl`. Without an export it stops, unless `--listens-full-history` is set explicitly. Until an import completes, every sync without `--export` stops with `lb_export_required`, even if some plays are in. A ZIP or another account's export is refused.
- Later syncs call `/listens` with `min_ts = last_listened_at - 3600` (overlap). `UNIQUE(source_key)` absorbs duplicates. They do not page the whole history.
- Live ListenBrainz verification is still pending; tests use fixtures and mocks only.

## Refresh / readers

- Two overlapping refreshes: the second is refused and does not delete the first lock.
- A crash mid-batch leaves none of that batch's rows.
- `recommend()` works on the committed state after every stage, and after a refresh that fails on an API outage.
- After a failed stage `status` shows 暫定 until a refresh succeeds.
- Readers open the main DB read-only. While refresh holds a write transaction they see the last committed state. Their handle cannot write.
- A schema v1 (djdb 0.1) main or online DB is refused with `schema_too_old`.

## Online DB

- `djdb init` and `djdb refresh` do not create it. `openReader({ online: 'write' })` creates it and binds it to the main DB's `lb_account_key`. The standalone MCP server never creates it.
- An online DB bound to another main DB disables `recommend` with `online_db_mismatch` and deletes nothing.
- `online-reset` empties tables in place, does not clear `sqlite_sequence`, and tells you to restart dj-mcp. Writes to old run ids return `unknown_run`.

## Live ListenBrainz (pending)

- Account signup / email confirmation is still outstanding. Do not treat mocked tests as live verification.
- Confirm: Loved import count vs. 161; whether `created` keeps the original Loved time; popularity endpoints not paused; listen uniqueness key; `listened_at` start vs. end around T0.

## Approved implementation notes

- Token file path: `~/.config/djdb-mcp/lb-token.json` (mode 0600). Approved.
- `DEFAULT_PARAMS` in `lib/recommend.mjs` are 暫定 / provisional and will be tuned after evaluation (`alpha=0.4`, `beta=0.5`, `rho=0.6`, `kappa=10`, `T=365d`, `q=20`, `m=3`).
- Standalone MCP tools: `status`, `recommend` (preview, `record: false`), `explain`. Library counts are part of `status`.
- Match order: MBID → ISRC → normalized name. Approved.
- Missing `recording_msid`: `source_key = lb:<listened_at>|nomssid:<hex>` with the hash defined in `nomssidFrom()`. Approved; covered by a stability test.
- First listen sync imports a ListenBrainz export; later syncs are `/listens` deltas with overlap. Full `/listens` paging only with `--listens-full-history`. Approved.
- `lb_feedback.track_id` is re-attached via MBID at the end of match. Approved.
