import { DjdbError } from './errors.mjs';
import { getMeta, setMeta } from './db.mjs';
import { withLockAsync } from './lock.mjs';
import { assertAccountLive } from './refresh.mjs';
import { createListenBrainzClient } from './listenbrainz.mjs';
import { resolveToken } from './token.mjs';

export async function accountRename(handle, newName, opts = {}) {
  if (!newName) throw new DjdbError('invalid_argument', 'account-rename requires the new ListenBrainz username');
  const locked = await withLockAsync(handle.paths.lockPath, 'account-rename', async () => {
    const token = resolveToken({ token: opts.token, tokenFile: handle.paths.tokenFile });
    const client = opts.client || createListenBrainzClient({ token, fetch: opts.fetch });
    const v = await client.validateToken();
    if (!v.valid) throw new DjdbError('lb_unauthorized', 'ListenBrainz token is not valid');
    if (v.user !== newName) {
      throw new DjdbError('lb_user_mismatch', `token belongs to '${v.user}', not '${newName}'`);
    }
    const current = getMeta(handle.main, 'lb_user');
    if (current === newName) return { unchanged: true, lb_user: current };
    setMeta(handle.main, 'lb_user', newName);
    return { ok: true, lb_user: newName, previous: current };
  }, opts);
  if (locked.locked) throw new DjdbError('locked', 'another djdb command holds djdb.lock');
  return locked.result;
}
