import { openSync, closeSync, writeSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DjdbError } from './errors.mjs';

function nowSec(now) {
  return Math.floor((now ? now() : Date.now()) / 1000);
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export function readLock(lockPath) {
  if (!existsSync(lockPath)) return null;
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return { pid: null, token: null, command: 'unknown', started_at: null, unreadable: true };
  }
}

export function lockStatus(lockPath) {
  const h = readLock(lockPath);
  if (!h) return null;
  if (h.unreadable) return `unreadable lock at ${lockPath}: run djdb unlock`;
  const when = h.started_at ?? '?';
  const cmd = h.command ?? '?';
  const pid = h.pid ?? '?';
  if (typeof h.pid === 'number' && pidAlive(h.pid)) {
    return `refresh running (pid ${pid}, ${cmd}, since ${when})`;
  }
  return `stale lock (pid ${pid}, ${cmd}, since ${when}): run djdb unlock`;
}

/**
 * Create the lock with wx. Only the creator may delete it, and only when pid+token still match.
 * No automatic stale-lock recovery.
 */
export async function withLockAsync(lockPath, command, fn, opts = {}) {
  const token = randomUUID();
  const started_at = opts.nowSec ?? nowSec(opts.now);
  let fd;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (e) {
    if (e.code === 'EEXIST') return { locked: true, holder: readLock(lockPath) };
    throw e;
  }
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, token, command, started_at }));
    closeSync(fd);
    fd = null;
    return { result: await fn() };
  } finally {
    try { if (fd != null) closeSync(fd); } catch {}
    try {
      const cur = JSON.parse(readFileSync(lockPath, 'utf8'));
      if (cur.pid === process.pid && cur.token === token) unlinkSync(lockPath);
    } catch {}
  }
}

/** Delete the lock only when the process that wrote it is gone. */
export function unlock(lockPath) {
  const h = readLock(lockPath);
  if (!h) return 'no lock';
  if (typeof h.pid === 'number' && pidAlive(h.pid)) {
    throw new DjdbError(
      'lock_held',
      `djdb.lock is held by running pid ${h.pid} (${h.command}, since ${h.started_at})`,
      `Wait for it to finish. If pid ${h.pid} is not a djdb command (for example after a reboot), delete ${lockPath} by hand.`,
    );
  }
  unlinkSync(lockPath);
  return 'deleted';
}
