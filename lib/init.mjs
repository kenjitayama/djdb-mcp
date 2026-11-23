import { randomUUID } from 'node:crypto';
import { existsSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { DjdbError } from './errors.mjs';
import { openWritable, initMainSchema, initOnlineSchema, setMeta, isInitialized } from './db.mjs';
import { withLockAsync } from './lock.mjs';
import { ensureDir } from './paths.mjs';
import { writeTokenFile, resolveToken } from './token.mjs';
import { createListenBrainzClient } from './listenbrainz.mjs';

/**
 * Create the main + online DBs and bind them to one ListenBrainz account.
 * lb_account_key is a UUID that never changes. The token file (mode 0600) holds only the token.
 */
export async function initDb(paths, opts = {}) {
  if (isInitialized(paths.dbPath) && !opts.force) {
    throw new DjdbError('already_initialized', `database already exists at ${paths.dbPath}`);
  }
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
  ensureDir(paths.snapsDir);
  const locked = await withLockAsync(paths.lockPath, 'init', () => {
    const db = openWritable(paths.dbPath);
    try {
      initMainSchema(db);
      const key = randomUUID();
      const epoch = randomUUID();
      setMeta(db, 'lb_account_key', key);
      setMeta(db, 'id_epoch', epoch);
      setMeta(db, 'lb_user', user);
      setMeta(db, 'dirty', '1');
      const odb = openWritable(paths.onlinePath);
      try {
        initOnlineSchema(odb);
        setMeta(odb, 'main_db_key', key);
        setMeta(odb, 'id_epoch', epoch);
      } finally {
        odb.close();
      }
      writeTokenFile(paths.tokenFile, { token });
      return { lb_user: user, lb_account_key: key, id_epoch: epoch, dbPath: paths.dbPath };
    } finally {
      db.close();
    }
  }, opts);
  if (locked.locked) {
    throw new DjdbError('locked', 'another djdb command holds djdb.lock');
  }
  return locked.result;
}
