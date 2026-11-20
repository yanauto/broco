import { formatDateTime } from './time.mjs'

export const localTime = formatDateTime

function hydrate(row) {
  if (!row) return null
  const atLocal = formatDateTime(row.at)
  const revertedAtLocal = row.revertedAt ? formatDateTime(row.revertedAt) : null
  return {
    id: Number(row.id),
    at: row.at,
    atLocal,
    atAsia: atLocal,
    scope: row.scope,
    scopeName: row.scopeName,
    actor: row.actor,
    action: row.action,
    summary: row.summary,
    beforeJson: row.beforeJson,
    afterJson: row.afterJson,
    before: JSON.parse(row.beforeJson),
    after: JSON.parse(row.afterJson),
    revertedAt: row.revertedAt ?? null,
    revertedAtLocal,
    revertedAtAsia: revertedAtLocal
  }
}

export class SettingsAudit {
  constructor(db) {
    this.db = db
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS settings_audit(' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      'at INTEGER NOT NULL,' +
      'atAsia TEXT NOT NULL,' +
      'scope TEXT NOT NULL,' +
      'scopeName TEXT NOT NULL,' +
      'actor TEXT NOT NULL,' +
      'action TEXT NOT NULL,' +
      'summary TEXT NOT NULL,' +
      'beforeJson TEXT NOT NULL,' +
      'afterJson TEXT NOT NULL,' +
      'revertedAt INTEGER' +
      ');' +
      'CREATE INDEX IF NOT EXISTS idx_settings_audit_scope ON settings_audit(scope, id DESC)'
    )
  }

  record({ scope, scopeName, actor = 'agent', action, summary, before, after, at = Date.now() }) {
    const atLocal = formatDateTime(at)
    const beforeJson = JSON.stringify(before ?? {})
    const afterJson = JSON.stringify(after ?? {})
    const res = this.db.prepare(
      'INSERT INTO settings_audit (at,atAsia,scope,scopeName,actor,action,summary,beforeJson,afterJson,revertedAt) VALUES (?,?,?,?,?,?,?,?,?,NULL)'
    ).run(at, atLocal, scope, scopeName || scope, actor || 'agent', action, summary, beforeJson, afterJson)
    return hydrate({
      id: Number(res.lastInsertRowid),
      at,
      atAsia: atLocal,
      scope,
      scopeName: scopeName || scope,
      actor: actor || 'agent',
      action,
      summary,
      beforeJson,
      afterJson,
      revertedAt: null
    })
  }

  get(id) {
    if (!Number.isSafeInteger(Number(id)) || Number(id) < 1) return null
    return hydrate(this.db.prepare('SELECT * FROM settings_audit WHERE id=?').get(Number(id)))
  }

  list(scope = null, limit = 30) {
    const max = Math.max(1, Math.min(500, Math.trunc(Number(limit) || 30)))
    const rows = scope && scope !== 'all'
      ? this.db.prepare('SELECT * FROM settings_audit WHERE scope=? ORDER BY id DESC LIMIT ?').all(scope, max)
      : this.db.prepare('SELECT * FROM settings_audit ORDER BY id DESC LIMIT ?').all(max)
    return rows.map(hydrate)
  }

  latestUndoable(scope = null) {
    if (scope && scope !== 'all') {
      const row = this.db.prepare("SELECT * FROM settings_audit WHERE scope=? AND revertedAt IS NULL AND action!='undo' ORDER BY id DESC LIMIT 1").get(scope)
      return hydrate(row)
    }
    const hasProjects = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects'").get())
    const sql = hasProjects
      ? "SELECT * FROM settings_audit WHERE revertedAt IS NULL AND action!='undo' AND (scope='global' OR EXISTS (SELECT 1 FROM projects WHERE id=settings_audit.scope)) ORDER BY id DESC LIMIT 1"
      : "SELECT * FROM settings_audit WHERE revertedAt IS NULL AND action!='undo' ORDER BY id DESC LIMIT 1"
    return hydrate(this.db.prepare(sql).get())
  }

  markReverted(id, at = Date.now()) {
    this.db.prepare('UPDATE settings_audit SET revertedAt=? WHERE id=?').run(at, Number(id))
  }

  archiveScope(scope, at = Date.now()) {
    this.db.prepare('UPDATE settings_audit SET revertedAt=? WHERE scope=? AND revertedAt IS NULL').run(at, scope)
  }
}
