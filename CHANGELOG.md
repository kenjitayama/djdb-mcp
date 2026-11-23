# Changelog

## 0.2.0

Breaking. A 0.1 database (schema v1) is refused with `schema_too_old`: move the data directory aside, then `djdb init` and `djdb refresh --export <dir>`. `API_VERSION` is 2.

Removed:
- Snapshots, `djdb restore`, `djdb snapshot-pin`, the dirty flag and `id_epoch`. Readers open the main DB read-only and read committed state directly.
- LB Radio, `randomSeed`, prompts, the `--token` flag, artist and track merging (`merged_into`), and the library exports dj-mcp does not use.

Changed:
- Readers use `openReader()`; `open()` is no longer exported. The online DB is created only by `openReader({ online: 'write' })`, binds to the main DB, and is never reset automatically.
- `recordExternalIds(online, runId, items, opts)` no longer takes the main DB. A run item stores where it can be played.
- `djdb refresh --export <dir>` takes the extracted export folder. The first sync needs it, and an import that stopped midway must be finished with the same export.
- `djdb unlock` checks the lock's pid and never asks.

Fixed:
- discover recommends recordings you have not played, including ones not in your library (#2).
- Evaluation at `cutoffAt` ignores later plays and hates (#13).
- A seed with a name and a URI resolves by the name (#4).
- Graph and popularity keep cached data when a request fails, report `partial`, and `status` shows 暫定 (#11).
- An MBID that arrives later attaches to the earlier name or ISRC match (#6). Dedup never merges plays whose MBIDs or ISRCs differ (#7).
- A failed init leaves no database (#10).
- `/listens` paging moves forward with `min_ts` and backward with `max_ts`, and requests are paced. Feedback paging reads every page.
- A run and its items are written together (#8). The Spotify ID cache is per market (#12).
- An unsupported Node, including 20, exits 2 with what to install.

## 0.1.0

First tagged version.
