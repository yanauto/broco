import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase } from './sqlite.mjs'
import { classify, infra } from './problems.mjs'
import { loadCatalog, matchModel } from './model-catalog.mjs'
import { home } from './paths.mjs'
import { formatDateTime } from './time.mjs'

export const outcomes = ['pass', 'rework', 'fail', 'blocked']

export const NO_COMPLETED_REPLY = '(It never completed a reply.)'
export function handoffPrompt(name, title, cwd, reply, text) {
  return ['You are taking over from an earlier session named ' + name + ', which has stopped. Its tool output and full history are not carried over: you get only its title, its working directory and its last completed reply, followed by the manager\'s request for you. Treat that reply as a summary, and check the files before relying on it.',
    'Earlier session: ' + name + '\nTitle: ' + title + '\nWorking directory: ' + cwd,
    'Its last completed reply:\n' + (reply ?? NO_COMPLETED_REPLY),
    'The manager\'s request for you:\n' + text].join('\n\n')
}

export function formatQueuedActivity(queue) {
  if (!queue) return 'Queued'
  const active = queue.activeNames?.length ? '; active: ' + queue.activeNames.join(', ') : ''
  return 'Queued (#' + queue.position + ' of ' + queue.totalQueued + ', limit ' + queue.limit + active + ')'
}

const TOOL_EVENT_KINDS = new Set([
  'tool.started',
  'tool.completed',
  'tool_execution_start',
  'tool_execution_end',
  'item/started',
  'item/completed',
  'item.started',
  'item.completed'
])

const builtinCatalogPath = fileURLToPath(new URL('./model-catalog.json', import.meta.url))
let catalogCache = null
let catalogCacheKey = ''

export function cachedCatalog() {
  const userPath = join(home, 'models.json')
  const bStat = statSync(builtinCatalogPath, { throwIfNoEntry: false })
  const uStat = statSync(userPath, { throwIfNoEntry: false })
  const key = (bStat?.mtimeMs ?? 0) + ':' + (uStat?.mtimeMs ?? -1) + ':' + userPath
  if (!catalogCache || catalogCacheKey !== key) {
    catalogCache = loadCatalog(userPath)
    catalogCacheKey = key
  }
  return catalogCache
}

function parseUsageRaw(rawText) {
  const { cachedInputTokens = null, inputTokens = null } = rawText ? JSON.parse(rawText) : {}
  return {
    cachedInputTokens,
    inputTokens,
    cacheRatio: inputTokens > 0 && cachedInputTokens !== null && cachedInputTokens >= 0 && cachedInputTokens <= inputTokens
      ? cachedInputTokens / inputTokens
      : null
  }
}

function computeQuotaSummary(rows) {
  if (!rows || !rows.length) return null
  const first = rows[0], last = rows.at(-1)
  const spent = (last.windows ?? []).map(w => {
    const before = (first.windows ?? []).find(b => b.minutes === w.minutes)
    return before && before.resetsAt === w.resetsAt ? { minutes: w.minutes, percent: Math.max(0, w.usedPercent - before.usedPercent) } : null
  }).filter(Boolean)
  return { latest: last, spent }
}

function buildContextWarning(c, usageTurn, usageRawText, execText, catalog) {
  if (!c || !usageRawText) return null
  const inputTokens = JSON.parse(usageRawText).inputTokens
  if (!Number.isSafeInteger(inputTokens)) return null
  const savedTokens = execText ? JSON.parse(execText)?.contextTokens : null
  const catalogTokens = matchModel(c.model, catalog)?.modalities?.context_tokens
  const contextTokens = (Number.isSafeInteger(savedTokens) && savedTokens > 0 ? savedTokens : null)
    ?? (Number.isSafeInteger(catalogTokens) && catalogTokens > 0 ? catalogTokens : null)
    ?? 250000
  const threshold = Math.floor(contextTokens * 0.6)
  if (inputTokens <= threshold) return null
  if (['running', 'queued'].includes(c.status)) {
    return {
      inputTokens,
      contextTokens,
      threshold,
      turn: usageTurn,
      actionable: false,
      message: '上下文已达阈值（运行中暂不切换）/ Context high (' + inputTokens + ' > ' + threshold + '): wait for current turn to finish before using --from ' + c.name + '.'
    }
  }
  return {
    inputTokens,
    contextTokens,
    threshold,
    turn: usageTurn,
    actionable: true,
    message: '该换新名字了 / Start a new name: inputTokens=' + inputTokens + ' > ' + threshold + '. Use broco say NEW_NAME "next task and project status files" --from ' + c.name + '.'
  }
}

export class Store {
  constructor(readOnly, path) {
    this.readOnly = Boolean(readOnly)
    this.db = openDatabase(path, { readOnly })
    this.directory = dirname(path)
    this.sessions = join(this.directory, 'sessions')
    this.sql = new Map()
    this.dirty = new Set()
    this.inTransaction = false
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON')
    if (readOnly) return
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL')
    this.db.exec([
      'CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, cwd TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, activity TEXT NOT NULL, turn INTEGER NOT NULL DEFAULT 0, worker_pid INTEGER, provider TEXT NOT NULL, native_id TEXT, transport TEXT)',
      'CREATE TABLE IF NOT EXISTS turns (cid TEXT REFERENCES conversations, turn INTEGER, status TEXT NOT NULL, started INTEGER NOT NULL, finished INTEGER, error TEXT, PRIMARY KEY(cid,turn))',
      'CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, cid TEXT NOT NULL, turn INTEGER NOT NULL, number INTEGER, kind TEXT NOT NULL, content TEXT NOT NULL, error TEXT, UNIQUE(cid,number), FOREIGN KEY(cid,turn) REFERENCES turns)',
      'CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, cid TEXT REFERENCES conversations, turn INTEGER NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, raw TEXT NOT NULL, summary TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS collaboration (cid TEXT PRIMARY KEY REFERENCES conversations, parent TEXT REFERENCES conversations, parent_turn INTEGER, worktree TEXT, branch TEXT, baseline TEXT, files TEXT)',
      'CREATE INDEX IF NOT EXISTS reviews_by_parent ON collaboration(parent)',
      'CREATE INDEX IF NOT EXISTS messages_by_turn ON messages(cid,turn,id)',
      "CREATE INDEX IF NOT EXISTS interjections_by_ticket ON events(cid,id) WHERE kind='bro.interjection'",
      "CREATE INDEX IF NOT EXISTS usage_by_turn ON events(cid,turn,id) WHERE kind='usage'",
      'CREATE INDEX IF NOT EXISTS events_by_turn ON events(cid,turn,id)',
      'CREATE INDEX IF NOT EXISTS events_by_cid ON events(cid,id)',
      "CREATE INDEX IF NOT EXISTS events_timeline ON events(cid,id,turn,at,kind,summary) WHERE summary<>''",
      "CREATE INDEX IF NOT EXISTS dispatch_by_turn ON events(cid,turn,id) WHERE kind='bro.dispatch'",
      'CREATE INDEX IF NOT EXISTS conversations_by_status ON conversations(status)',
      'CREATE TABLE IF NOT EXISTS tickets (cid TEXT PRIMARY KEY REFERENCES conversations, title TEXT NOT NULL, stage TEXT NOT NULL, flag TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL, started INTEGER)',
      'CREATE TABLE IF NOT EXISTS runtime_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS batches (prefix TEXT PRIMARY KEY, title TEXT NOT NULL, brief TEXT NOT NULL, worker TEXT, model TEXT, effort TEXT, cwd TEXT, created INTEGER NOT NULL, shards TEXT NOT NULL)',
      "INSERT OR IGNORE INTO tickets(cid,title,stage,flag,created,updated,started) SELECT c.id,c.name,CASE WHEN c.turn=0 THEN 'queued' WHEN c.status='idle' THEN 'review' ELSE 'working' END, CASE WHEN c.status IN ('error','stopped') THEN c.status END, coalesce((SELECT min(started) FROM turns WHERE cid=c.id),0),coalesce(r.finished,r.started,0),r.started FROM conversations c LEFT JOIN turns r ON r.cid=c.id AND r.turn=c.turn"
    ].join(';'))
    if (!this.db.prepare('PRAGMA table_info(conversations)').all().some(c => c.name === 'thinking')) this.db.exec('ALTER TABLE conversations ADD COLUMN thinking TEXT')
    if (!this.db.prepare('PRAGMA table_info(collaboration)').all().some(c => c.name === 'cwd')) this.db.exec('ALTER TABLE collaboration ADD COLUMN cwd TEXT')
    const turnColumns = this.db.prepare('PRAGMA table_info(turns)').all().map(c => c.name)
    if (!turnColumns.includes('execution')) this.db.exec('ALTER TABLE turns ADD COLUMN execution TEXT')
    if (!turnColumns.includes('problem')) this.db.exec('ALTER TABLE turns ADD COLUMN problem TEXT')
    const fill = this.db.prepare('UPDATE turns SET problem=? WHERE cid=? AND turn=?')
    const unclassified = this.db.prepare("SELECT cid,turn,error FROM turns WHERE status='error' AND problem IS NULL").all()
    if (unclassified.length) this.transaction(() => { for (const t of unclassified) fill.run(JSON.stringify(classify(t.error)), t.cid, t.turn) })
    const ticketColumns = this.db.prepare('PRAGMA table_info(tickets)').all().map(c => c.name)
    for (const column of ['outcome TEXT', 'outcome_reason TEXT', 'outcome_at INTEGER']) if (!ticketColumns.includes(column.split(' ')[0])) this.db.exec('ALTER TABLE tickets ADD COLUMN ' + column)
    this.db.exec("CREATE INDEX IF NOT EXISTS quota_by_turn ON events(cid,turn,id) WHERE kind='quota'")
    this.transaction(() => {
      this.db.exec('CREATE TABLE IF NOT EXISTS tasks (cid TEXT REFERENCES conversations, number INTEGER NOT NULL, title TEXT NOT NULL, start_turn INTEGER NOT NULL, end_turn INTEGER NOT NULL, model TEXT NOT NULL, thinking TEXT, outcome TEXT, outcome_reason TEXT, outcome_at INTEGER, PRIMARY KEY(cid,number))')
      this.db.exec("INSERT INTO tasks SELECT c.id,1,t.title,1,coalesce((SELECT max(turn) FROM turns WHERE cid=c.id),0),c.model,c.thinking,t.outcome,t.outcome_reason,t.outcome_at FROM conversations c JOIN tickets t ON t.cid=c.id WHERE NOT EXISTS (SELECT 1 FROM tasks WHERE cid=c.id)")
    })
  }

  marker(id) { return join(this.directory, 'workers', id) }

  stmt(sql) {
    if (!this.sql.has(sql)) this.sql.set(sql, this.db.prepare(sql))
    return this.sql.get(sql)
  }

  hasTable(name) {
    return Boolean(this.stmt("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))
  }

  setMetaValue(key, value) {
    if (this.readOnly || !this.hasTable('runtime_meta')) return
    const text = String(value)
    const existing = this.stmt('SELECT value FROM runtime_meta WHERE key=?').get(key)
    if (existing?.value === text) return
    this.stmt('INSERT INTO runtime_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, text)
  }

  getMetaValue(key) {
    if (!this.hasTable('runtime_meta')) return null
    return this.stmt('SELECT value FROM runtime_meta WHERE key=?').get(key)?.value ?? null
  }

  concurrencyLimit() {
    const stored = Number(this.getMetaValue('concurrency'))
    if (Number.isSafeInteger(stored) && stored >= 1) return stored
    const envLimit = Number(process.env.BROCO_CONCURRENCY ?? 3)
    return Number.isSafeInteger(envLimit) && envLimit >= 1 ? envLimit : 3
  }

  queueSnapshotMap() {
    const queued = this.stmt("SELECT c.id FROM conversations c LEFT JOIN turns r ON r.cid=c.id AND r.turn=c.turn WHERE c.status='queued' ORDER BY r.started ASC, r.rowid ASC, c.rowid ASC").all()
    const map = new Map()
    if (!queued.length) return map
    const activeNames = this.stmt("SELECT c.name FROM conversations c LEFT JOIN turns r ON r.cid=c.id AND r.turn=c.turn WHERE c.status='running' ORDER BY r.started ASC, r.rowid ASC, c.name ASC").all().map(r => r.name)
    const limit = this.concurrencyLimit()
    const totalQueued = queued.length
    for (let i = 0; i < totalQueued; i++) {
      const cid = queued[i].id
      const live = this.queueInfo?.(cid)
      if (live) {
        map.set(cid, {
          position: live.position,
          totalQueued: live.totalQueued,
          limit: live.limit,
          activeNames: [...(live.activeNames ?? [])]
        })
      } else {
        map.set(cid, {
          position: i + 1,
          totalQueued,
          limit,
          activeNames: [...activeNames]
        })
      }
    }
    return map
  }

  queueStatus(cid) {
    const c = this.stmt('SELECT id,status FROM conversations WHERE id=?').get(cid)
    if (!c || c.status !== 'queued') return null
    const live = this.queueInfo?.(cid)
    if (live) {
      return {
        position: live.position,
        totalQueued: live.totalQueued,
        limit: live.limit,
        activeNames: [...(live.activeNames ?? [])]
      }
    }
    return this.queueSnapshotMap().get(cid) ?? null
  }

  catalog() {
    return cachedCatalog()
  }

  transaction(fn) {
    if (this.inTransaction || this.db.isTransaction) return fn()
    this.db.exec(this.readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE')
    this.inTransaction = true
    let value
    try {
      value = fn()
      this.db.exec('COMMIT')
    } catch (err) {
      try { this.db.exec('ROLLBACK') } catch {}
      this.dirty.clear()
      throw err
    } finally {
      this.inTransaction = false
    }
    const changed = [...this.dirty]
    this.dirty.clear()
    for (const cid of changed) this.onChange?.(cid)
    return value
  }

  changed(cid) {
    this.stmt('UPDATE tickets SET updated=max(updated+1,?) WHERE cid=?').run(Date.now(), cid)
    this.dirty.add(cid)
  }

  byName(name) {
    return this.stmt('SELECT * FROM conversations WHERE name=?').get(name)
  }

  create(name, cwd, model, title, thinking, provider) {
    return this.transaction(() => {
      const id = randomUUID()
      this.stmt("INSERT INTO conversations(id,name,cwd,model,thinking,provider,status,activity) VALUES (?,?,?,?,?,?,'idle','Ready')").run(id, name, cwd, model, thinking, provider)
      this.stmt("INSERT INTO tickets(cid,title,stage,created,updated) VALUES (?,?,'queued',?,?)").run(id, title || name, Date.now(), Date.now())
      return this.byName(name)
    })
  }

  state(cid, status, activity) {
    this.transaction(() => {
      this.stmt('UPDATE conversations SET status=?,activity=? WHERE id=?').run(status, activity, cid)
      if (status === 'error' || status === 'stopped') this.stmt('UPDATE tickets SET flag=? WHERE cid=?').run(status, cid)
      this.changed(cid)
    })
  }

  owner(cid, pid) {
    this.stmt('UPDATE conversations SET worker_pid=? WHERE id=?').run(pid, cid)
  }

  event(cid, turn, kind, raw, summary = '') {
    this.stmt('INSERT INTO events(cid,turn,at,kind,raw,summary) VALUES (?,?,?,?,?,?)').run(cid, turn, Date.now(), kind, JSON.stringify(raw), summary)
  }

  tasks(cid) {
    return this.stmt('SELECT number AS task,title,start_turn AS startTurn,end_turn AS endTurn,model,thinking AS effort,outcome,outcome_reason AS outcomeReason,outcome_at AS outcomeAt FROM tasks WHERE cid=? ORDER BY number').all(cid)
  }

  currentTask(cid) {
    return this.stmt('SELECT number AS task,title,start_turn AS startTurn,end_turn AS endTurn,model,thinking AS effort,outcome,outcome_reason AS outcomeReason,outcome_at AS outcomeAt FROM tasks WHERE cid=? ORDER BY number DESC LIMIT 1').get(cid)
  }

  accept(c, text, title, newTask = false) {
    return this.transaction(() => {
      const turn = this.nextTurn(c.id)
      const previous = this.currentTask(c.id)
      if (newTask && previous && !previous.outcome) throw new Error('Record the current task with done before --new-task')
      const task = previous ? previous.task + (newTask ? 1 : 0) : 1
      if (!previous || newTask) {
        this.stmt('INSERT INTO tasks(cid,number,title,start_turn,end_turn,model,thinking) VALUES (?,?,?,?,?,?,?)').run(c.id, task, title || (previous ? c.name : this.stmt('SELECT title FROM tickets WHERE cid=?').get(c.id).title), turn, turn, c.model, c.thinking)
      }
      this.stmt('UPDATE tasks SET end_turn=?,model=?,thinking=?,outcome=NULL,outcome_reason=NULL,outcome_at=NULL WHERE cid=? AND number=?').run(turn, c.model, c.thinking, c.id, task)
      if (title) this.stmt('UPDATE tasks SET title=? WHERE cid=? AND number=?').run(title, c.id, task)
      if (newTask) this.stmt('UPDATE tickets SET title=? WHERE cid=?').run(title || c.name, c.id)
      this.stmt("INSERT INTO turns(cid,turn,status,started) VALUES (?,?,'queued',?)").run(c.id, turn, Date.now())
      this.stmt("UPDATE conversations SET turn=?,status='queued',activity='Queued' WHERE id=?").run(turn, c.id)
      this.stmt("UPDATE tickets SET stage='queued',flag=NULL,started=NULL,outcome=NULL,outcome_reason=NULL,outcome_at=NULL WHERE cid=?").run(c.id)
      if (title) this.stmt('UPDATE tickets SET title=? WHERE cid=?').run(title, c.id)
      this.changed(c.id)
      const number = this.message(c.id, turn, 'prompt', text)
      this.event(c.id, turn, 'bro.say', { number, kind: 'prompt', task }, 'Queued')
      return { name: c.name, number, turn, task, kind: 'prompt' }
    })
  }

  nextTurn(cid) {
    return this.stmt('SELECT coalesce(max(turn),0)+1 AS n FROM turns WHERE cid=?').get(cid).n
  }

  meta(cid) {
    return this.stmt('SELECT * FROM collaboration WHERE cid=?').get(cid)
  }

  message(cid, turn, kind, text, error = null) {
    const { number } = this.stmt('SELECT coalesce(max(number),0)+1 AS number FROM messages WHERE cid=?').get(cid)
    this.stmt('INSERT INTO messages(cid,turn,number,kind,content,error) VALUES (?,?,?,?,?,?)').run(cid, turn, number, kind, text, error)
    return number
  }

  follow(c, text, outcome, reason, turn = outcome === 'queued' ? c.turn + 1 : c.turn, pendingNumber) {
    return this.transaction(() => {
      if (outcome === 'queued') {
        this.stmt("INSERT OR IGNORE INTO turns(cid,turn,status,started) VALUES (?,?,'queued',?)").run(c.id, turn, Date.now())
      }
      const task = this.currentTask(c.id)?.task
      if (outcome !== 'rejected') this.stmt('UPDATE tasks SET end_turn=max(end_turn,?) WHERE cid=? AND number=?').run(turn, c.id, task)
      const kind = outcome === 'queued' ? 'next' : outcome === 'injected' ? 'steer' : 'rejected'
      const error = outcome === 'rejected' ? reason : null
      const number = pendingNumber ?? this.message(c.id, turn, kind, text, error)
      if (pendingNumber !== undefined) this.stmt("UPDATE messages SET turn=?,kind=?,error=? WHERE cid=? AND number=? AND kind='pending'").run(turn, kind, error, c.id, number)
      const receipt = { name: c.name, turn, task, number, kind, outcome, reason }
      this.event(c.id, turn, 'bro.interjection', receipt, outcome + ': ' + reason)
      this.changed(c.id)
      return receipt
    })
  }

  claim(c) {
    this.transaction(() => {
      this.stmt("UPDATE turns SET status='running' WHERE cid=? AND turn=?").run(c.id, c.turn)
      this.state(c.id, 'running', 'Starting worker')
    })
  }

  working(c) {
    this.transaction(() => {
      this.stmt("UPDATE tickets SET stage='working',flag=NULL,started=? WHERE cid=?").run(Date.now(), c.id)
      this.state(c.id, 'running', 'Working')
      this.event(c.id, c.turn, 'bro.working', {}, 'Working')
    })
  }

  done(name, { result, why, task } = {}) {
    const c = this.byName(name)
    if (!c) throw new Error('Unknown ticket: ' + name)
    if (task !== undefined && (!Number.isSafeInteger(task) || task < 1)) throw new Error('Expected a positive task number')
    const current = this.currentTask(c.id)
    const selected = task === undefined ? current : this.tasks(c.id).find(t => t.task === task)
    if (!selected) throw new Error('Unknown task: ' + task)
    const archived = selected.task !== current.task
    const ticket = archived ? { id: name, ...selected, status: 'done' } : this.ticket(c.id)
    if (result !== undefined && !outcomes.includes(result)) throw new Error('Expected --result ' + outcomes.join('|'))
    if (why !== undefined && (typeof why !== 'string' || why.length > 2000)) throw new Error('Invalid --why')
    if (ticket.status === 'done' && result === undefined) return ticket
    const closable = ticket.status === 'review' || (result !== undefined && outcomes.includes(result) && ['error', 'stopped'].includes(c.status))
    if (ticket.status !== 'done' && !closable) throw new Error(['fail', 'blocked'].includes(result) ? 'Only finished, failed or stopped tickets can be closed' : 'Only tickets in review can be accepted; use --result fail or blocked to close a failed ticket, or any --result to close an interrupted ticket')
    const turns = this.stmt('SELECT problem FROM turns WHERE cid=? AND turn BETWEEN ? AND ?').all(c.id, selected.startTurn, selected.endTurn).filter(t => !infra.includes(t.problem ? JSON.parse(t.problem).class : '')).length
    const outcome = result ?? (turns > 1 ? 'rework' : 'pass')
    const label = outcome === 'fail' ? 'Closed as failed by manager' : outcome === 'blocked' ? 'Closed as blocked by manager' : 'Accepted by manager'
    this.transaction(() => {
      const at = Date.now()
      this.stmt('UPDATE tasks SET outcome=?,outcome_reason=?,outcome_at=? WHERE cid=? AND number=?').run(outcome, why ?? null, at, c.id, selected.task)
      if (!archived) {
        this.stmt("UPDATE tickets SET stage='done',flag=NULL,outcome=?,outcome_reason=?,outcome_at=? WHERE cid=?").run(outcome, why ?? null, at, c.id)
        this.state(c.id, 'idle', label)
      } else this.changed(c.id)
      this.event(c.id, selected.endTurn, 'bro.accepted', { task: selected.task, outcome, why: why ?? null }, label + ' · task ' + selected.task + ' · ' + outcome)
    })
    if (!archived) this.onDone?.(c.id)
    return archived ? { id: name, ...this.tasks(c.id).find(t => t.task === selected.task), status: 'done' } : this.ticket(c.id)
  }

  assistant(cid, turn, text) {
    if (!text) return null
    return this.stmt("INSERT INTO messages(cid,turn,kind,content) VALUES (?,?,'assistant',?)").run(cid, turn, text).lastInsertRowid
  }

  rejectDeferred(cid, turn, reason) {
    for (const { number } of this.stmt("SELECT number FROM messages WHERE cid=? AND turn=? AND kind='next' AND error IS NULL").all(cid, turn)) {
      this.stmt('UPDATE messages SET error=? WHERE cid=? AND number=?').run(reason, cid, number)
      this.event(cid, turn, 'bro.interjection', { number, turn, outcome: 'rejected', reason }, 'rejected: ' + reason)
    }
  }

  finish(cid, turn, status, detail, replyId = null, problem = null) {
    return this.transaction(() => {
      if (status === 'error') problem ??= classify(detail)
      const updated = this.stmt("UPDATE turns SET status=?,finished=?,error=?,problem=? WHERE cid=? AND turn=? AND status IN ('queued','running')").run(status, Date.now(), status === 'done' ? null : detail, status === 'error' ? JSON.stringify(problem) : null, cid, turn)
      if (!updated.changes) {
        this.onStaleFinish?.(cid, turn)
        return false
      }
      if (replyId !== null) this.stmt("UPDATE messages SET kind='reply' WHERE cid=? AND turn=? AND id=?").run(cid, turn, replyId)
      if (status === 'done') this.stmt("UPDATE tickets SET stage='review',flag=NULL WHERE cid=?").run(cid)
      this.state(cid, status === 'done' ? 'idle' : status, detail)
      this.event(cid, turn, 'bro.' + status, problem ? { problem } : {}, detail)
      const next = this.stmt("SELECT turn FROM turns WHERE cid=? AND turn>? AND status='queued' ORDER BY turn LIMIT 1").get(cid, turn)
      if (next && status === 'done') {
        this.stmt("UPDATE conversations SET turn=?,status='queued',activity='Queued follow-up' WHERE id=?").run(next.turn, cid)
        this.stmt("UPDATE tickets SET stage='queued',flag=NULL,started=NULL WHERE cid=?").run(cid)
      } else if (next) {
        const reason = 'Previous turn did not complete: ' + detail
        const nextProblem = status === 'error' ? JSON.stringify(classify(reason)) : null
        this.stmt("UPDATE turns SET status=?,error=?,problem=?,finished=? WHERE cid=? AND turn=?").run(status, reason, nextProblem, Date.now(), cid, next.turn)
        this.rejectDeferred(cid, next.turn, reason)
      }
      this.onFinish?.(cid, next && status === 'done')
      return true
    })
  }

  list() {
    const rawRows = this.stmt('SELECT c.id,c.name,c.model,c.cwd,c.status,c.activity,c.turn,r.started,r.finished FROM conversations c LEFT JOIN turns r ON r.cid=c.id AND r.turn=c.turn ORDER BY c.name').all()
    const hasQueued = rawRows.some(r => r.status === 'queued')
    const queueMap = hasQueued && !this.queueInfo ? this.queueSnapshotMap() : null
    return rawRows.map(({ id, ...row }) => {
      const queue = row.status === 'queued'
        ? (this.queueInfo ? this.queueStatus(id) : (queueMap?.get(id) ?? null))
        : null
      return { ...row, activity: queue ? formatQueuedActivity(queue) : row.activity, queue }
    })
  }

  batchMembershipMap() {
    const map = new Map()
    if (!this.hasTable('batches')) return map
    for (const row of this.stmt('SELECT prefix, shards FROM batches').all()) {
      const shards = JSON.parse(row.shards)
      const count = shards.length
      for (const s of shards) {
        map.set(s.name, { prefix: row.prefix, index: s.index, count, input: s.input })
      }
    }
    return map
  }

  ticketRows(where = '', ...params) {
    const hasTasks = this.hasTable('tasks')
    const sql = `
      SELECT
        c.id AS cid,
        c.status AS conversationStatus,
        c.name AS id,
        c.cwd,
        t.title,
        t.stage AS status,
        t.flag,
        t.outcome,
        t.outcome_reason AS outcomeReason,
        t.outcome_at AS ticketOutcomeAt,
        c.provider,
        c.model,
        c.thinking AS effort,
        c.activity,
        c.turn,
        t.created,
        t.updated,
        t.started,
        r.finished,
        r.execution,
        r.problem,
        m.parent AS parentCid,
        p.name AS parentName,
        m.parent_turn AS parentTurn,
        m.worktree,
        m.branch,
        m.files,
        ${hasTasks ? 'tk.number AS taskNumber, tk.title AS taskTitle, tk.start_turn AS startTurn, tk.end_turn AS endTurn, tk.model AS taskModel, tk.thinking AS taskEffort, tk.outcome AS taskOutcome, tk.outcome_reason AS taskOutcomeReason, tk.outcome_at AS taskOutcomeAt,' : 'NULL AS taskNumber, NULL AS taskTitle, NULL AS startTurn, NULL AS endTurn, NULL AS taskModel, NULL AS taskEffort, NULL AS taskOutcome, NULL AS taskOutcomeReason, NULL AS taskOutcomeAt,'}
        (SELECT at FROM events e WHERE e.cid=c.id AND e.turn=c.turn ORDER BY e.id DESC LIMIT 1) AS lastEventAt,
        (SELECT raw FROM events e WHERE e.cid=c.id AND e.turn=c.turn AND e.kind='usage' ORDER BY e.id DESC LIMIT 1) AS turnUsageRaw,
        (SELECT turn FROM events e WHERE e.cid=c.id AND e.turn<=c.turn AND e.kind='usage' ORDER BY e.turn DESC,e.id DESC LIMIT 1) AS latestUsageTurn,
        (SELECT raw FROM events e WHERE e.cid=c.id AND e.turn<=c.turn AND e.kind='usage' ORDER BY e.turn DESC,e.id DESC LIMIT 1) AS latestUsageRaw,
        (SELECT execution FROM turns tx WHERE tx.cid=c.id AND tx.turn<=c.turn AND tx.execution IS NOT NULL ORDER BY tx.turn DESC LIMIT 1) AS latestExecution
      FROM tickets t
      JOIN conversations c ON c.id=t.cid
      LEFT JOIN turns r ON r.cid=c.id AND r.turn=c.turn
      LEFT JOIN collaboration m ON m.cid=c.id
      LEFT JOIN conversations p ON p.id=m.parent
      ${hasTasks ? 'LEFT JOIN tasks tk ON tk.cid=c.id AND tk.number=(SELECT max(number) FROM tasks WHERE cid=c.id)' : ''}
    `
    const rows = this.stmt(sql + where + ' ORDER BY t.created,c.name').all(...params)
    if (!rows.length) return []

    const cids = rows.map(r => r.cid)
    const cidsJson = JSON.stringify(cids)
    const hasQueued = rows.some(r => r.conversationStatus === 'queued')
    const queueMap = hasQueued && !this.queueInfo ? this.queueSnapshotMap() : null
    const batchMap = this.batchMembershipMap()
    const catalog = this.catalog()

    const reviewsByCid = new Map()
    for (const rv of this.stmt('SELECT m.parent AS cid,c.name AS id,m.parent_turn AS turn FROM collaboration m JOIN conversations c ON c.id=m.cid WHERE m.parent IN (SELECT value FROM json_each(?)) ORDER BY m.rowid').all(cidsJson)) {
      let arr = reviewsByCid.get(rv.cid)
      if (!arr) { arr = []; reviewsByCid.set(rv.cid, arr) }
      arr.push({ id: rv.id, turn: rv.turn })
    }

    const interjectionsByCid = new Map()
    for (const ij of this.stmt("SELECT cid,raw FROM events WHERE kind='bro.interjection' AND cid IN (SELECT value FROM json_each(?)) ORDER BY id").all(cidsJson)) {
      let arr = interjectionsByCid.get(ij.cid)
      if (!arr) { arr = []; interjectionsByCid.set(ij.cid, arr) }
      arr.push(JSON.parse(ij.raw))
    }

    const quotaByCid = new Map()
    for (const q of this.stmt("SELECT e.cid,e.raw FROM events e JOIN conversations c ON c.id=e.cid AND e.turn=c.turn WHERE e.kind='quota' AND e.cid IN (SELECT value FROM json_each(?)) ORDER BY e.id").all(cidsJson)) {
      let arr = quotaByCid.get(q.cid)
      if (!arr) { arr = []; quotaByCid.set(q.cid, arr) }
      arr.push(JSON.parse(q.raw))
    }

    const stepStateByCid = new Map()
    for (const ev of this.stmt("SELECT e.cid,e.kind,e.summary FROM events e JOIN conversations c ON c.id=e.cid AND e.turn=c.turn WHERE e.summary<>'' AND e.cid IN (SELECT value FROM json_each(?)) ORDER BY e.id").all(cidsJson)) {
      if (!TOOL_EVENT_KINDS.has(ev.kind)) continue
      let state = stepStateByCid.get(ev.cid)
      if (!state) { state = { any: null, preferred: null }; stepStateByCid.set(ev.cid, state) }
      state.any = ev.summary
      if (!/^(?:agent_response\b|Writing reply$)/.test(ev.summary)) state.preferred = ev.summary
    }

    const needLegacyDispatch = []
    const parsedExecByCid = new Map()
    for (const row of rows) {
      const parsedExec = row.execution ? JSON.parse(row.execution) : null
      parsedExecByCid.set(row.cid, parsedExec)
      if (!parsedExec || !Object.hasOwn(parsedExec, 'note')) needLegacyDispatch.push(row.cid)
    }

    const legacyDispatchByCid = new Map()
    if (needLegacyDispatch.length) {
      for (const d of this.stmt("SELECT e.cid,e.raw FROM events e JOIN conversations c ON c.id=e.cid AND e.turn=c.turn WHERE e.kind='bro.dispatch' AND e.cid IN (SELECT value FROM json_each(?)) ORDER BY e.id").all(JSON.stringify(needLegacyDispatch))) {
        legacyDispatchByCid.set(d.cid, JSON.parse(d.raw))
      }
    }

    const nowMs = Date.now()
    return rows.map(row => {
      const {
        cid, conversationStatus, created, updated, started, finished,
        execution, problem, parentCid, parentName, parentTurn, worktree, branch, files,
        ticketOutcomeAt, taskNumber, taskTitle, startTurn, endTurn, taskModel, taskEffort, taskOutcome, taskOutcomeReason, taskOutcomeAt,
        lastEventAt, turnUsageRaw, latestUsageTurn, latestUsageRaw, latestExecution,
        ...fields
      } = row

      const queue = conversationStatus === 'queued'
        ? (this.queueInfo ? this.queueStatus(cid) : (queueMap?.get(cid) ?? null))
        : null
      if (queue) fields.activity = formatQueuedActivity(queue)

      const parsedExec = parsedExecByCid.get(cid)
      if (parsedExec && Object.hasOwn(parsedExec, 'note')) {
        Object.assign(fields, { note: parsedExec.note, rules: parsedExec.rules, capability: parsedExec.capability })
      } else if (legacyDispatchByCid.has(cid)) {
        Object.assign(fields, legacyDispatchByCid.get(cid))
      }

      if (taskNumber !== null) {
        Object.assign(fields, {
          task: taskNumber,
          title: taskTitle,
          startTurn,
          endTurn,
          model: taskModel,
          effort: taskEffort,
          outcome: taskOutcome,
          outcomeReason: taskOutcomeReason
        })
      }

      const rawOutcomeAt = taskNumber !== null ? taskOutcomeAt : ticketOutcomeAt
      const usage = {
        ...parseUsageRaw(turnUsageRaw),
        quota: computeQuotaSummary(quotaByCid.get(cid)),
        problem: problem ? JSON.parse(problem) : null
      }
      const parent = parentCid ? (parentName ?? null) : null
      const stepState = stepStateByCid.get(cid)
      const currentStep = stepState?.preferred ?? stepState?.any ?? null
      const lastHeartbeatAt = lastEventAt ? new Date(lastEventAt).toISOString() : null
      const contextWarning = buildContextWarning(
        { name: fields.id, model: row.model, status: conversationStatus },
        latestUsageTurn,
        latestUsageRaw,
        latestExecution,
        catalog
      )

      Object.assign(fields, usage, {
        outcomeAt: rawOutcomeAt ? new Date(rawOutcomeAt).toISOString() : null,
        contextWarning,
        currentStep,
        lastHeartbeatAt,
        batch: batchMap.get(fields.id) ?? null,
        queue,
        parent,
        parentTurn: parentTurn ?? null,
        reviews: reviewsByCid.get(cid) ?? [],
        interjections: interjectionsByCid.get(cid) ?? [],
        branch: branch ?? null,
        worktree: worktree ?? null,
        changedFiles: JSON.parse(files ?? 'null')
      })

      if (fields.status === 'done' && fields.worktree && !parent) {
        fields.cleanupHint = 'Worktree and branch retained. After preserving changes, remove the worktree manually: ' + fields.worktree
      }

      return {
        ...fields,
        createdAt: new Date(created).toISOString(),
        updatedAt: new Date(updated).toISOString(),
        startedAt: started === null ? null : new Date(started).toISOString(),
        elapsedMs: started === null ? 0 : Math.max(0, (finished ?? nowMs) - started)
      }
    })
  }

  ticket(cid) {
    return this.ticketRows('WHERE t.cid=?', cid)[0]
  }

  detail(name) {
    const c = this.byName(name)
    if (!c) return null
    const ticket = this.ticket(c.id)
    const lastReply = this.reply(c.id, c.turn) ?? null
    const eventStats = this.stmt('SELECT count(*) AS n FROM events WHERE cid=?').get(c.id)
    const latestEvent = this.stmt('SELECT at FROM events WHERE cid=? ORDER BY id DESC LIMIT 1').get(c.id)
    const rows = this.stmt("SELECT turn,at,kind,summary FROM events WHERE cid=? AND summary<>'' ORDER BY id").all(c.id)
    const groups = []
    for (const e of rows) {
      const prev = groups.at(-1)
      if (prev && prev.turn === e.turn && prev.kind === e.kind && prev.rawSummary === e.summary) {
        prev.lastAt = e.at
        prev.count += 1
      } else {
        groups.push({ turn: e.turn, firstAt: e.at, lastAt: e.at, count: 1, kind: e.kind, rawSummary: e.summary })
      }
    }
    const timeline = groups.map(g => {
      const firstIso = new Date(g.firstAt).toISOString()
      const lastIso = new Date(g.lastAt).toISOString()
      const localTime = formatDateTime(g.lastAt)
      return {
        turn: g.turn,
        ts: firstIso,
        lastTs: lastIso,
        count: g.count,
        kind: g.kind,
        rawSummary: g.rawSummary,
        summary: g.count > 1 ? g.rawSummary + ' (×' + g.count + ', last ' + localTime + ')' : g.rawSummary
      }
    })
    const turnTools = rows.filter(r => r.turn === c.turn && TOOL_EVENT_KINDS.has(r.kind))
    const latestTool = turnTools.filter(r => !/^(?:agent_response\b|Writing reply$)/.test(r.summary)).at(-1) ?? turnTools.at(-1)
    const recentMessages = this.stmt('SELECT turn,number,kind,content,error FROM messages WHERE cid=? ORDER BY id DESC LIMIT 10').all(c.id).reverse()
    const progress = {
      status: c.status,
      activity: ticket.activity,
      currentStep: latestTool?.summary ?? null,
      lastHeartbeatAt: latestEvent?.at ? new Date(latestEvent.at).toISOString() : null,
      eventCount: eventStats?.n ?? 0,
      changedFilesCount: ticket.changedFiles?.length ?? 0,
      queue: ticket.queue ?? null
    }
    return { ...ticket, tasks: this.tasks(c.id), lastReply, recentMessages, progress, timeline }
  }

  history(cid) {
    return this.stmt('SELECT turn,number,kind,content,error FROM messages WHERE cid=? ORDER BY id').all(cid)
  }

  reply(cid, turn) {
    return this.stmt("SELECT content FROM messages WHERE cid=? AND turn=? AND kind='reply' ORDER BY id DESC LIMIT 1").get(cid, turn)?.content
  }

  usage(cid, turn) {
    const row = this.stmt("SELECT raw FROM events WHERE cid=? AND turn=? AND kind='usage' ORDER BY id DESC LIMIT 1").get(cid, turn)
    return parseUsageRaw(row?.raw)
  }

  contextWarning(cid, turn) {
    const row = this.stmt("SELECT turn,raw FROM events WHERE cid=? AND turn<=? AND kind='usage' ORDER BY turn DESC,id DESC LIMIT 1").get(cid, turn)
    if (!row) return null
    const c = this.stmt('SELECT id,name,model,status FROM conversations WHERE id=?').get(cid)
    if (!c) return null
    const execRow = this.stmt('SELECT execution FROM turns WHERE cid=? AND turn<=? AND execution IS NOT NULL ORDER BY turn DESC LIMIT 1').get(cid, turn)
    return buildContextWarning(c, row.turn, row.raw, execRow?.execution ?? null, this.catalog())
  }

  handoff(name, text) {
    const c = this.byName(name)
    if (!c) throw new Error('Unknown handoff source: ' + name)
    if (['running', 'queued'].includes(c.status)) throw new Error('Handoff needs an inactive source; wait for or stop ' + name)
    if (typeof text !== 'string' || !text.trim()) throw new Error('Message is empty')
    const reply = this.stmt("SELECT m.content FROM messages m JOIN turns t ON t.cid=m.cid AND t.turn=m.turn WHERE m.cid=? AND m.kind='reply' AND t.status='done' ORDER BY m.turn DESC,m.id DESC LIMIT 1").get(c.id)
    return handoffPrompt(name, this.ticket(c.id).title, c.cwd, reply?.content, text)
  }

  problem(cid, turn) {
    const row = this.stmt('SELECT problem FROM turns WHERE cid=? AND turn=?').get(cid, turn)
    return row?.problem ? JSON.parse(row.problem) : null
  }

  quota(cid, turn) {
    const rows = this.stmt("SELECT raw FROM events WHERE cid=? AND turn=? AND kind='quota' ORDER BY id").all(cid, turn).map(r => JSON.parse(r.raw))
    return computeQuotaSummary(rows)
  }

  result(cid, turn) {
    const t = this.stmt('SELECT turn,status,error FROM turns WHERE cid=? AND turn=?').get(cid, turn)
    if (!t) throw new Error('Unknown turn ' + turn)
    const queue = t.status === 'queued' ? this.queueStatus(cid) : null
    return { ...t, ...this.usage(cid, turn), contextWarning: this.contextWarning(cid, turn), quota: this.quota(cid, turn), problem: this.problem(cid, turn), queue, reply: this.reply(cid, turn) ?? null }
  }
}
