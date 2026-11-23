import { openSync, closeSync, writeSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

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
  if (h.unreadable) return `unreadable lock at ${lockPath}: run djdb unlock --force`;
  const when = h.started_at ?? '?';
  const cmd = h.command ?? '?';
  const pid = h.pid ?? '?';
  if (typeof h.pid === 'number' && pidAlive(h.pid)) {
    return `refresh running (pid ${pid}, ${cmd}, since ${when})`;
  }
  return `stale lock (pid ${pid}, ${cmd}, since ${when}): run djdb unlock --force`;
}

/**
 * Create the lock with wx. Only the creator may delete it, and only when pid+token still match.
 * No automatic stale-lock recovery.
 */
export function withLock(lockPath, command, fn, opts = {}) {
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
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(
        (r) => {
          release();
          return { result: r };
        },
        (err) => {
          release();
          throw err;
        },
      );
    }
    return { result };
  } finally {
    // Sync path: release here. Async path releases in then/catch and must not double-unlink
    // after the promise is returned — only release if we did not already hand off.
    if (fd != null) {
      try { closeSync(fd); } catch {}
    }
  }

  function release() {
    try {
      const cur = JSON.parse(readFileSync(lockPath, 'utf8'));
      if (cur.pid === process.pid && cur.token === token) unlinkSync(lockPath);
    } catch {
      /* already gone or unreadable */
    }
  }
}

// Wrap sync withLock so the finally of the sync path also releases after fn() returns.
export function withLockSync(lockPath, command, fn, opts = {}) {
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
    return { result: fn() };
  } finally {
    try { if (fd != null) closeSync(fd); } catch {}
    try {
      const cur = JSON.parse(readFileSync(lockPath, 'utf8'));
      if (cur.pid === process.pid && cur.token === token) unlinkSync(lockPath);
    } catch {}
  }
}

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

export function unlockForce(lockPath, confirm) {
  if (!existsSync(lockPath)) return 'no lock';
  const h = readLock(lockPath);
  const prompt = `lock held by pid ${h.pid} (${h.command}, since ${h.started_at}). delete? [y/N]`;
  if (!confirm(prompt)) return 'kept';
  unlinkSync(lockPath);
  return 'deleted';
}
