export const BATCH_SIZE = 2000;

/** A write batch: its changes land in one transaction, or none do. Returns the number of changes fn reports. */
export function batch(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const changed = fn();
    db.exec('COMMIT');
    return typeof changed === 'number' ? changed : (changed ? 1 : 0);
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}
