import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DjdbError } from './errors.mjs';
import { openWritable, initMainSchema, setMeta } from './db.mjs';
import { withLockAsync } from './lock.mjs';
import { ensureDir } from './paths.mjs';
import { writeTokenFile, resolveToken } from './token.mjs';
import { createListenBrainzClient } from './listenbrainz.mjs';

/**
 * Create the main DB and bind it to one ListenBrainz account. The online DB is created on first use.
 * lb_account_key is a UUID that never changes. The token file (mode 0600) holds only the token.
 * The DB is built under a temporary name and renamed into place, so a failed init leaves no database.
 */
export async function initDb(paths, opts = {}) {
  refuseExisting(paths);
  const token = resolveToken({ token: opts.token, tokenFile: paths.tokenFile });
  if (!token) throw new DjdbError('lb_token_missing', 'No ListenBrainz token', 'Set LISTENBRAINZ_TOKEN or write the token file.');
  const client = opts.client || createListenBrainzClient({ token, fetch: opts.fetch });
  const v = opts.skipTokenCheck
    ? { valid: true, user: opts.user }
    : await client.validateToken();
  if (!v.valid) throw new DjdbError('lb_unauthorized', 'ListenBrainz token is not valid');
  if (opts.user && v.user && opts.user !== v.user) {
    throw new DjdbError('lb_user_mismatch', `requested user '${opts.user}' but token belongs to '${v.user}'`);
  }
  const user = v.user || opts.user;
  if (!user) throw new DjdbError('lb_user_missing', 'could not determine the ListenBrainz username');

  ensureDir(paths.dbDir);
  const locked = await withLockAsync(paths.lockPath, 'init', () => {
    refuseExisting(paths);
    removeLeftovers(paths.dbPath);
    writeTokenFile(paths.tokenFile, { token });
    const tmp = `${paths.dbPath}${TMP_INFIX}${randomUUID().slice(0, 8)}`;
    const key = randomUUID();
    try {
      const db = openWritable(tmp);
      try {
        initMainSchema(db);
        setMeta(db, 'lb_account_key', key);
        setMeta(db, 'lb_user', user);
      } finally {
        db.close();
      }
      renameSync(tmp, paths.dbPath);
    } catch (e) {
      for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) rmSync(f, { force: true });
      throw e;
    }
    return { lb_user: user, lb_account_key: key, dbPath: paths.dbPath };
  }, opts);
  if (locked.locked) {
    throw new DjdbError('locked', 'another djdb command holds djdb.lock');
  }
  return locked.result;
}

const TMP_INFIX = '.init-';

function refuseExisting(paths) {
  const found = [paths.dbPath, paths.onlinePath].filter((f) => existsSync(f));
  if (found.length) {
    throw new DjdbError(
      'already_initialized',
      `djdb files already exist: ${found.join(', ')}`,
      'To start over, move the djdb data directory aside first. To keep it, pass --db <path> for a new database.',
    );
  }
}

/** Temporary DBs of an init that crashed before its rename. */
function removeLeftovers(dbPath) {
  const dir = join(dbPath, '..');
  const prefix = basename(dbPath) + TMP_INFIX;
  for (const name of readdirSync(dir)) {
    if (name.startsWith(prefix)) rmSync(join(dir, name), { force: true });
  }
}
