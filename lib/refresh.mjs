import { readdirSync, unlinkSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { DjdbError } from './errors.mjs';
import { getMeta, setMeta, migrateMain, LIB_USER_VERSION, userVersion } from './db.mjs';
import { withLockAsync } from './lock.mjs';
import { batch, isDirty } from './batch.mjs';
import { cleanupUnregistered, validateSnapshots, publishSnapshot, cleanupSnapshots } from './snapshot.mjs';
import { syncListensFromClient, syncFeedbackFromClient } from './sync.mjs';
import { matchPlays, dedupPlays, relinkFeedback } from './match.mjs';
import { refreshGraph } from './graph.mjs';
import { refreshPopularity } from './popularity.mjs';
import { createListenBrainzClient } from './listenbrainz.mjs';
import { readTokenFile, resolveToken } from './token.mjs';

/**
 * djdb refresh: lock, migrate, clean leftovers, then lb-sync → match → graph → popularity,
 * then publish a snapshot if dirty or if no valid snapshot remains.
 */
export async function refresh(handle, opts = {}) {
  const { main: db, paths } = handle;
  const locked = await withLockAsync(paths.lockPath, 'refresh', () => runRefresh(handle, opts), opts);
  if (locked.locked) {
    throw new DjdbError('locked', 'another djdb command holds djdb.lock', 'Wait, or inspect with djdb status and djdb unlock --force if the lock is stale.');
  }
  return locked.result;
}

async function runRefresh(handle, opts) {
  const { main: db, paths } = handle;
  // leftovers of a crashed restore
  cleanupRestoreTemps(paths.dbDir, paths.dbPath);
  cleanupUnregistered(db, paths.snapsDir);
  const { validIds, badPinned } = validateSnapshots(db, paths.snapsDir);

  const uv = userVersion(db);
  if (uv < LIB_USER_VERSION.max) {
    batch(db, () => {
      migrateMain(db);
      return 1;
    });
  }

  const stages = opts.stages || defaultStages(handle, opts);
  const results = [];
  let failed = null;
  for (const s of stages) {
    try {
      const r = await s.run();
      results.push({ name: s.name, ok: true, ...wrap(r) });
    } catch (e) {
      failed = { name: s.name, error: e };
      results.push({ name: s.name, ok: false, error: e.message, code: e.code, status: e.status });
      break;
    }
  }

  if (failed) {
    if (validIds.size === 0) {
      publishSnapshot(db, paths.snapsDir, { keepDirty: true, nowSec: opts.nowSec });
      setMeta(db, 'refresh_note', `snapshot taken after stage ${failed.name} failed`);
      cleanupSnapshots(db, paths.snapsDir, 2);
      return { ok: false, fallbackSnapshot: true, provisional: true, failed: failed.name, results, badPinned, note: `stage ${failed.name} failed; fallback snapshot` };
    }
    setMeta(db, 'refresh_note', `stage ${failed.name} failed`);
    return { ok: false, fallbackSnapshot: false, failed: failed.name, results, badPinned, note: `stage ${failed.name} failed` };
  }

  setMeta(db, 'refresh_note', '');
  if (!isDirty(db) && validIds.size > 0) {
    return { ok: true, published: false, note: 'no change', results, badPinned };
  }
  const rel = publishSnapshot(db, paths.snapsDir, { nowSec: opts.nowSec });
  cleanupSnapshots(db, paths.snapsDir, 2);
  return { ok: true, published: true, path: rel, results, badPinned };
}

function wrap(r) {
  return r && typeof r === 'object' ? r : { value: r };
}

function defaultStages(handle, opts) {
  const { main: db, paths } = handle;
  const client = opts.client || createClient(handle, opts);
  const user = getMeta(db, 'lb_user');
  return [
    {
      name: 'lb-sync',
      run: async () => {
        await assertAccountLive(handle, opts, client);
        const listens = await syncListensFromClient(db, client, user, opts);
        const feedback = await syncFeedbackFromClient(db, client, user, opts);
        if (feedback.ok === false && opts.requireFeedback) throw feedback.error || new Error(feedback.reason);
        return { listens, feedback };
      },
    },
    {
      name: 'match',
      run: async () => {
        const matched = matchPlays(db, opts);
        const dedup = dedupPlays(db);
        const feedbackLinks = relinkFeedback(db);
        return { ...matched, ...dedup, feedbackLinks };
      },
    },
    {
      name: 'graph',
      run: async () => refreshGraph(db, client, opts),
    },
    {
      name: 'popularity',
      run: async () => refreshPopularity(db, client, opts),
    },
  ];
}

function createClient(handle, opts) {
  const token = resolveToken({ token: opts.token, tokenFile: handle.paths.tokenFile });
  return createListenBrainzClient({ ...opts.lb, token, fetch: opts.fetch, sleep: opts.sleep });
}

export function assertAccount(handle, opts, client) {
  const db = handle.main;
  const key = getMeta(db, 'lb_account_key');
  const user = getMeta(db, 'lb_user');
  if (!key || !user) throw new DjdbError('not_initialized', 'database is not initialized', 'Run djdb init.');
  const stored = readTokenFile(handle.paths.tokenFile);
  if (stored?.lb_account_key && stored.lb_account_key !== key) {
    throw new DjdbError('account_key_mismatch', 'ListenBrainz token file is bound to a different db account key');
  }
  if (opts.skipTokenCheck) return { user, key };
  if (!client) return { user, key };
  return { user, key, validate: true };
}

export async function assertAccountLive(handle, opts, client) {
  const base = assertAccount(handle, opts, client);
  if (opts.skipTokenCheck) return base;
  const v = await client.validateToken();
  if (!v.valid) throw new DjdbError('lb_unauthorized', 'ListenBrainz token is not valid');
  if (v.user && v.user !== getMeta(handle.main, 'lb_user')) {
    throw new DjdbError(
      'lb_user_changed',
      `token belongs to '${v.user}', but this database is bound to '${getMeta(handle.main, 'lb_user')}'`,
      'If you renamed the ListenBrainz account, run djdb account-rename.',
    );
  }
  return { ...base, validatedUser: v.user };
}

export function cleanupRestoreTemps(dbDir, dbPath) {
  const prefix = basename(dbPath) + '.restore-';
  if (!existsSync(dbDir)) return 0;
  let n = 0;
  for (const f of readdirSync(dbDir)) {
    if (f.startsWith(prefix)) {
      try { unlinkSync(join(dbDir, f)); n++; } catch {}
    }
  }
  return n;
}
