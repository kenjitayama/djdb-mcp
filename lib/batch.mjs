import { getMeta, setMeta } from './db.mjs';

export const BATCH_SIZE = 2000;

/** A write batch: changes and dirty=1 land in the same transaction, or neither does. */
export function batch(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const changed = fn();
    const n = typeof changed === 'number' ? changed : (changed ? 1 : 0);
    if (n > 0) setMeta(db, 'dirty', '1');
    db.exec('COMMIT');
    return n;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

export function isDirty(db) {
  return getMeta(db, 'dirty') === '1';
}
