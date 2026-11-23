# Verification checklist

## Automated

- `node test/validate-schema.mjs` prints `VALIDATION_OK rejects=16 checks=75`.
- `npm test` (or `node --test test/*.test.mjs`) passes, including the stdio MCP smoke test.
- Docs never suggest invoking the CLI via a bare unscoped name from a public registry.
- Tracked files contain no tokens, Client IDs, device names, personal usernames, or machine-local absolute paths.

## Node

- Runtime and `engines` are `>=24.15.0 <25 || >=26 <27`.
- On an out-of-range Node, binaries exit 2 with a clear message; dj-mcp (engines `>=20`) must keep working and only disable the recommender.

## Init / token

- `LISTENBRAINZ_TOKEN` or the token file is required. The token file is `~/.config/djdb-mcp/lb-token.json`, mode `0600`, and also stores `lb_account_key`.
- The CLI and MCP server never print the token.
- A username mismatch during `refresh` tells you to run `djdb account-rename`.

## Refresh / snapshots

- Two overlapping refreshes: the second is refused and does not delete the first lock.
- A crash mid-batch leaves neither the new rows nor `dirty=1`.
- A crash after `VACUUM INTO` leaves an unregistered file that the next refresh deletes.
- After a failed stage with no valid snapshot, one provisional snapshot is taken and `status` shows 暫定.
- Readers open snapshots with `immutable=1` and do not create `-wal`/`-shm`.

## Restore / online-reset

- `page_size` of the backup and the live DB must match, or restore stops with a reason.
- `backup()` is applied in place (same inode, open connections see the restored DB).
- A crash before `backup()` leaves the live DB unchanged.
- `online-reset` empties tables in place, does not clear `sqlite_sequence`, and tells you to restart dj-mcp. Writes to old run ids return `unknown_run`.

## Live ListenBrainz (pending)

- Account signup / email confirmation is still outstanding. Do not treat mocked tests as live verification.
- Confirm: Loved import count vs. 161; whether `created` keeps the original Loved time; LB Radio / popularity endpoints not paused; listen uniqueness key; `listened_at` start vs. end around T0.

## Implementation choices not spelled out in the v11 design

- Token file path: `~/.config/djdb-mcp/lb-token.json` (mode 0600).
- Default algorithm parameters: see `DEFAULT_PARAMS` in `lib/recommend.mjs` (`alpha=0.4`, `beta=0.5`, `rho=0.6`, `kappa=10`, `T=365d`, `q=20`, `m=3`).
- Standalone MCP tools: `status`, `recommend` (preview, `record: false`), `explain`, `library_stats`.
- `lb_feedback.track_id` is filled again at the end of the match stage, because feedback is pulled in `lb-sync` before tracks exist.
