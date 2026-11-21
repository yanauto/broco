import { DatabaseSync } from 'node:sqlite'

export function openDatabase(path, { readOnly = false, busyTimeout = 5000 } = {}) {
  const db = readOnly ? new DatabaseSync(path, { readOnly: true }) : new DatabaseSync(path)
  if (busyTimeout > 0) {
    db.exec('PRAGMA busy_timeout=' + Math.trunc(busyTimeout))
  }
  return db
}
