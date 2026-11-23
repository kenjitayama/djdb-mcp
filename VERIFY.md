# Verification checklist

## Automated

- `npm test` (or `node --test test/*.test.mjs`) passes, including the schema tests and the stdio MCP smoke test.
- Docs never suggest invoking the CLI via a bare unscoped name from a public registry.
- Tracked files contain no tokens, Client IDs, device names, personal usernames, or machine-local absolute paths.

## Node

- Runtime and `engines` are `>=24.15.0 <25 || >=26 <27`.
- On an out-of-range Node, both binaries exit 2 with the range and what to install, including Node 20, which cannot load `node:sqlite`. dj-mcp (engines `>=20`) must keep working and only disable the recommender.

## Init / token

- `LISTENBRAINZ_TOKEN` or the token file is required. The token file is `~/.config/djdb-mcp/lb-token.json`, mode `0600`, and holds only `token`. There is no `--token` flag. Docs show only placeholder values such as `YOUR_LISTENBRAINZ_TOKEN`.
- The CLI and MCP server never print the token.
- Init saves the token file with mode `0600`, refuses an existing database, and a failed init leaves no database.
- A username mismatch during `refresh` tells you to run `djdb account-rename`.

## Listen sync
- First sync requires `--export <dir>` (or `LISTENBRAINZ_EXPORT`), the extracted export with `user.json` and `listens/<year>/<month>.jsonl`. Without an export it stops, unless `--listens-full-history` is set explicitly. Until an import completes, every sync without `--export` stops with `lb_export_required`, even if some plays are in. A ZIP or another account's export is refused.
- Later syncs call `/listens` with `min_ts = last_listened_at - 3600` (overlap) and page forward. `UNIQUE(source_key)` absorbs duplicates. They do not page the whole history. Requests are paced, and a rate-limit header pauses until it resets.
- A listen added to ListenBrainz later with an old timestamp is not in a delta; a new export with `--export` brings it in without duplicates. A listen deleted on ListenBrainz stays in djdb.
- On 2026-11-23 the response shapes of `/listens`, feedback, popularity and labs similar-artists were checked against the live API without a token, and the fake in `test/lb-fake.mjs` refuses the similar-artists parameters the live API refuses. Listen sync with a real account is still pending.

## Refresh / readers

- Two overlapping refreshes: the second is refused and does not delete the first lock.
- While a refresh holds the lock, `status` stays `ok`, shows the lock, and `recommend()` returns items.
- A crash mid-batch leaves none of that batch's rows.
- `recommend()` works on the committed state after every stage, and after a refresh that fails on an API outage.
- After a failed stage, or a stage with failed ListenBrainz requests (`partial`), `status` shows 暫定 until a complete refresh.
- A failed graph or popularity request keeps the cached response and its edges. A 2xx that is not JSON or has the wrong shape counts as failed (`lb_bad_response`): listens fail `lb-sync` without marking the import done, feedback keeps the old set and marks `lb-sync` partial, and nothing invalid is cached.
- Readers open the main DB read-only. While refresh holds a write transaction they see the last committed state. Their handle cannot write.
- A schema v1 (djdb 0.1) main or online DB is refused with `schema_too_old`.

## Recommend

- discover returns recordings not played before the cutoff, including catalog recordings never played, and skips the same song under another recording.
- Hates and plays after `cutoffAt` do not affect a run at that cutoff.
- A recorded run and its items are written together, or not at all.
- The ID cache is per market.
- Each track appears once, even when two artists share a top recording.

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
