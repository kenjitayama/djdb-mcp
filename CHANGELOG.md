# Changelog

## 0.2.1

No schema or API change. `API_VERSION` stays 2.

Changed:
- Output and docs are in English only. `status` writes its note as `Provisional: the last refresh was incomplete (...)` (it began with a Japanese word before), and the MCP server's `status` tool description says "provisional". Comments, test names, VERIFY and the skill follow. CJK names remain only in the tests that check CJK normalization.
- The README calls `djdb-online.sqlite` the run log: a local SQLite file next to the main DB, called the online DB in the code and CLI.
- README: a Purpose section, timeless wording for dj-mcp without this package (it works, without `recommend`), and generic advice on importing your history into ListenBrainz.

## 0.2.0

Breaking. A 0.1 database (schema v1) is refused with `schema_too_old`: move the data directory aside, then `djdb init` and `djdb refresh --export <dir>`. `API_VERSION` is 2.

Removed:
- Snapshots, `djdb restore`, `djdb snapshot-pin`, the dirty flag and `id_epoch`. Readers open the main DB read-only and read committed state directly.
- LB Radio, `randomSeed`, prompts, the `--token` flag, artist and track merging (`merged_into`), and the library exports dj-mcp does not use.

Changed:
- Readers use `openReader()`; `open()` is no longer exported. The online DB is created only by `openReader({ online: 'write' })`, binds to the main DB, and is never reset automatically.
- `recordExternalIds(online, runId, items, opts)` no longer takes the main DB. A run item stores where it can be played. Items with neither a recording MBID nor an ISRC are stored on the run but not cached.
- `djdb refresh --export <dir>` takes the extracted export folder. The first sync needs it, and an import that stopped midway must be finished with the same export.
- `djdb unlock` checks the lock's pid and never asks.

Fixed:
- discover recommends recordings you have not played, including ones not in your library (#2).
- Evaluation at `cutoffAt` ignores later plays and hates (#13).
- A seed with a name and a URI resolves by the name (#4).
- Graph and popularity keep cached data when a request fails, report `partial`, and `status` marks the library provisional (#11).
- An MBID that arrives later attaches to the earlier name or ISRC match (#6). Dedup never merges plays whose MBIDs or ISRCs differ (#7).
- A failed init leaves no database (#10).
- `/listens` paging moves forward with `min_ts` and backward with `max_ts`, and requests are paced. Feedback paging reads every page.
- A run and its items are written together (#8). The Spotify ID cache is per market (#12).
- An unsupported Node, including 20, exits 2 with what to install.
- `status` reports a held or stale `djdb.lock` under `lock` and stays `ok`, so recommend keeps working during a refresh.
- Similar artists are requested with `artist_mbids` and an algorithm the labs API accepts (`..._skip_30`). The old request was always refused with 400.
- A ListenBrainz 2xx that is not JSON, or not the shape of that endpoint, fails with `lb_bad_response` before anything is written. So do feedback pages that stop before `total_count`. A failed feedback fetch keeps the old set and marks `lb-sync` partial.
- A play without IDs joins a played track of the same name that has an MBID. A dedup pair is split again when ListenBrainz maps its plays to different MBIDs. A changed mapping clears the play's old match at once.
- recommend returns each track once. Only the kept top recordings of an artist are cached.

## 0.1.0

First tagged version.
