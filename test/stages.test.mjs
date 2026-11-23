// Readers use the main DB directly, so every committed refresh stage must leave a state recommend can use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as H from './helpers.mjs';
import { library, libraryClient, REC_UNKNOWN } from './library.mjs';
import { refresh, defaultStages } from '../lib/refresh.mjs';
import { openReader } from '../lib/open.mjs';
import { recommend } from '../lib/recommend.mjs';
import { status } from '../lib/status.mjs';

async function readerView(dbPath, configDir) {
  const h = openReader({ dbPath, configDir, online: 'read' });
  try {
    const count = (t) => h.main.prepare(`SELECT count(*) AS n FROM ${t}`).get().n;
    const rec = await recommend(h, { mode: 'discover', n: 5, record: false, cutoffAt: 2_000_000_000 });
    assert.ok(Array.isArray(rec.items), JSON.stringify(rec));
    return { plays: count('play'), matched: count('play WHERE track_id IS NOT NULL'), edges: count('edge'), tops: count("fetch_cache WHERE endpoint='lb:top-recordings'"), items: rec.items.map((i) => i.recording_mbid) };
  } finally {
    h.close();
  }
}

test('recommend works on the committed state after every refresh stage', async () => {
  const client = libraryClient();
  const { handle, dbPath, configDir } = await H.freshDb({ client });
  try {
    const opts = { client, skipTokenCheck: true, listensFullHistory: true };
    const views = {};
    const probe = (after) => ({ name: `probe-${after}`, run: async () => { views[after] = await readerView(dbPath, configDir); } });
    const stages = defaultStages(handle, opts).flatMap((s) => [s, probe(s.name)]);
    const r = await refresh(handle, { ...opts, stages });
    assert.equal(r.ok, true, JSON.stringify(r.results));
    assert.deepEqual(Object.keys(views), ['lb-sync', 'match', 'graph', 'popularity']);
    assert.equal(views['lb-sync'].plays, 41);
    assert.equal(views['lb-sync'].matched, 0);
    assert.equal(views.match.matched, 41);
    assert.equal(views.match.edges, 0);
    assert.ok(views.graph.edges > 0);
    assert.equal(views.graph.tops, 0);
    assert.ok(views.popularity.tops > 0);
    assert.ok(views.popularity.items.includes(REC_UNKNOWN), JSON.stringify(views.popularity));
  } finally {
    handle.close();
  }
});

test('a refresh that fails on an API outage keeps the last committed state readable', async () => {
  const { handle, dbPath, configDir } = await library();
  try {
    const before = await readerView(dbPath, configDir);
    const down = libraryClient({ fail: { listens: true, feedback: true, similar: true, popularity: true, tops: true } });
    const r = await refresh(handle, { client: down, skipTokenCheck: true });
    assert.equal(r.ok, false);
    assert.equal(r.failed, 'lb-sync');
    assert.deepEqual(await readerView(dbPath, configDir), before);
    const st = status(handle);
    assert.equal(st.ok, true);
    assert.match(st.provisional_note, /暫定.*lb-sync/);
    const again = await refresh(handle, { client: libraryClient(), skipTokenCheck: true });
    assert.equal(again.ok, true, JSON.stringify(again.results));
    assert.equal(status(handle).provisional, false);
  } finally {
    handle.close();
  }
});
