import { DjdbError } from './errors.mjs';
import { getMeta, setMeta, assertSchema } from './db.mjs';
import { withLockAsync } from './lock.mjs';
import { syncListens, syncFeedbackFromClient } from './sync.mjs';
import { matchPlays, dedupPlays, relinkFeedback, unpairContradicted } from './match.mjs';
import { refreshGraph } from './graph.mjs';
import { refreshPopularity } from './popularity.mjs';
import { createListenBrainzClient } from './listenbrainz.mjs';
import { resolveToken } from './token.mjs';

/**
 * djdb refresh: lock, then lb-sync → match → graph → popularity. Each stage commits in batches,
 * so readers see every committed batch. A failed stage stops the run; earlier stages stay committed.
 * A stage that reports `partial` (some LB requests failed, old cache rows used) does not stop the run.
 * Ends by writing refreshed_at and refresh_note ('' when every stage was complete).
 */
export async function refresh(handle, opts = {}) {
  const { paths } = handle;
  const locked = await withLockAsync(paths.lockPath, 'refresh', () => runRefresh(handle, opts), opts);
  if (locked.locked) {
    throw new DjdbError('locked', 'another djdb command holds djdb.lock', 'Wait, or check djdb status; djdb unlock removes the lock if its pid is gone.');
  }
  return locked.result;
}

async function runRefresh(handle, opts) {
  const { main: db, paths } = handle;
  assertSchema(db, 'main', paths.dbPath);
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
  const partial = results.filter((s) => s.partial).map((s) => `stage ${s.name} partial: ${s.failed} LB requests failed`);
  const note = failed ? `stage ${failed.name} failed: ${failed.error.message}` : partial.join('; ');
  db.exec('BEGIN IMMEDIATE');
  setMeta(db, 'refreshed_at', String(opts.nowSec ?? Math.floor(Date.now() / 1000)));
  setMeta(db, 'refresh_note', note);
  db.exec('COMMIT');
  return failed ? { ok: false, failed: failed.name, results, note } : { ok: true, results };
}

function wrap(r) {
  return r && typeof r === 'object' ? r : { value: r };
}

export function defaultStages(handle, opts) {
  const { main: db, paths } = handle;
  const client = opts.client || createClient(handle, opts);
  const user = getMeta(db, 'lb_user');
  return [
    {
      name: 'lb-sync',
      run: async () => {
        await assertAccountLive(handle, opts, client);
        const listens = await syncListens(db, client, user, opts);
        const feedback = await syncFeedbackFromClient(db, client, user, opts);
        if (feedback.ok !== false) return { listens, feedback };
        if (opts.requireFeedback) throw feedback.error || new Error(feedback.reason);
        const { error, ...rest } = feedback;
        return { listens, feedback: { ...rest, error: error?.message, code: error?.code }, partial: true, failed: 1 };
      },
    },
    {
      name: 'match',
      run: async () => {
        const { unpaired } = unpairContradicted(db);
        const matched = matchPlays(db, opts);
        const dedup = dedupPlays(db);
        const feedbackLinks = relinkFeedback(db);
        return { unpaired, ...matched, ...dedup, feedbackLinks };
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

