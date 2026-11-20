import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { Crew } from './crew.mjs'
import { ensureAgentsMd, removeAgentsMd, resolveAgentsDocPath } from './claude-md.mjs'
import { listBatches } from './map.mjs'
import { canonical, home, isWithinPath, samePath } from './paths.mjs'
import { formatDateTime } from './time.mjs'
import { Store } from './store.mjs'
import { Roster } from './roster.mjs'
import { supportedWorker, workerPolicy } from './worker-policy.mjs'

const ticketsPath = id => join(home, 'projects', id, 'tickets.sqlite')
const within = (path, root) => isWithinPath(path, root)
const info = path => lstatSync(path, { throwIfNoEntry: false })
const NO_PROJECT_OR_GLOBAL = 'Project is not registered and no global worker allowlist is configured. Run broco setup, broco allow <workers> --global, or broco init in the project root.'

function validProjectRoot(repoPath) {
  return Boolean(
    existsSync(repoPath) &&
    statSync(repoPath).isDirectory() &&
    basename(repoPath) &&
    !within(home, repoPath) &&
    !within(repoPath, home) &&
    !samePath(repoPath, canonical(homedir()))
  )
}

function gitRoot(path) {
  const env = { ...process.env }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_INDEX_FILE
  delete env.GIT_COMMON_DIR
  delete env.GIT_OBJECT_DIRECTORY
  try {
    const out = execFileSync('git', ['--no-optional-locks', '-C', path, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
      windowsHide: true,
      env
    }).trim()
    if (!out) return null
    const resolved = canonical(out)
    if (!within(path, resolved) || !validProjectRoot(resolved)) return null
    return resolved
  } catch {
    return null
  }
}

export function workspaceRoot(cwd) {
  const path = canonical(cwd)
  return gitRoot(path) ?? path
}

function binding(root) {
  const dir = join(root, '.broco')
  if (info(dir) && !info(dir).isDirectory()) throw new Error('Expected a .broco directory at ' + root)
  const file = join(dir, 'project-id')
  if (info(file)) {
    if (!info(file).isFile()) throw new Error('Invalid project-id at ' + root)
    return readFileSync(file, 'utf8').trim()
  }
  const legacyDir = join(root, '.cc-bro')
  if (info(legacyDir)?.isDirectory()) {
    const legacyFile = join(legacyDir, 'project-id')
    if (info(legacyFile)?.isFile()) return readFileSync(legacyFile, 'utf8').trim()
  }
  return null
}

function bind(root, id) {
  const dir = join(root, '.broco')
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of [['.gitignore', '*\n'], ['project-id', id + '\n']]) {
    const file = join(dir, name)
    if (!info(file)) writeFileSync(file, content, { flag: 'wx' })
    else if (!info(file).isFile() || readFileSync(file, 'utf8').trim() !== content.trim()) throw new Error('Conflicting project marker: ' + file)
  }
}

export class Projects {
  constructor(slots, publish = () => {}, hasListeners = () => true) {
    mkdirSync(home, { recursive: true })
    this.db = new DatabaseSync(join(home, 'registry-v2.sqlite'))
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON')
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,repoPath TEXT NOT NULL UNIQUE,created INTEGER NOT NULL,allow TEXT NOT NULL,worker TEXT NOT NULL,concurrency INTEGER,implicit INTEGER NOT NULL DEFAULT 0); ' +
      'CREATE TABLE IF NOT EXISTS runner_state (id INTEGER PRIMARY KEY CHECK (id=1), pid INTEGER, ppid INTEGER, started INTEGER, stop_reason TEXT, stopped INTEGER, web_port INTEGER)'
    )
    const projectCols = this.db.prepare('PRAGMA table_info(projects)').all()
    if (!projectCols.some(c => c.name === 'concurrency')) {
      this.db.exec('ALTER TABLE projects ADD COLUMN concurrency INTEGER')
    }
    if (!projectCols.some(c => c.name === 'implicit')) {
      this.db.exec('ALTER TABLE projects ADD COLUMN implicit INTEGER NOT NULL DEFAULT 0')
    }
    if (!this.db.prepare('PRAGMA table_info(runner_state)').all().some(c => c.name === 'web_port')) {
      this.db.exec('ALTER TABLE runner_state ADD COLUMN web_port INTEGER')
    }
    this.slots = slots
    this.publish = publish ?? (() => {})
    this.hasListeners = typeof hasListeners === 'function' ? hasListeners : () => true
    this.onTicketChange = null
    this._dirty = new Map()
    this._flushScheduled = false
    this.entries = new Map()
    this.roster = new Roster(this)
    const globalConcurrency = this.roster.read('global').concurrency
    if (Number.isSafeInteger(globalConcurrency) && globalConcurrency >= 1) {
      this.slots?.setLimit?.('global', globalConcurrency)
    }
  }

  saveWebPort(port) {
    const val = port === null || port === undefined ? null : Number(port)
    if (val !== null && (!Number.isSafeInteger(val) || val < 1 || val > 65535)) {
      throw new Error('Invalid web port: ' + port)
    }
    this.db.prepare('INSERT INTO runner_state(id,web_port) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET web_port=excluded.web_port').run(val)
    return val
  }

  readWebPort() {
    const port = this.db.prepare('SELECT web_port FROM runner_state WHERE id=1').get()?.web_port ?? null
    return Number.isSafeInteger(port) && port >= 1 && port <= 65535 ? port : null
  }

  markTicketChanged(projectId, cid) {
    if (!this.entries.has(projectId)) return
    let set = this._dirty.get(projectId)
    if (!set) {
      set = new Set()
      this._dirty.set(projectId, set)
    }
    if (cid) set.add(cid)
    if (this._flushScheduled) return
    this._flushScheduled = true
    queueMicrotask(() => this.flushChanges())
  }

  flushChanges() {
    this._flushScheduled = false
    const batches = [...this._dirty.entries()]
    this._dirty.clear()
    const shouldPublish = Boolean(this.hasListeners?.())
    for (const [projectId, cids] of batches) {
      const p = this.entries.get(projectId)
      if (!p) continue
      const list = [...cids]
      try { this.onTicketChange?.(projectId, list) } catch {}
      if (!shouldPublish) continue
      try {
        if (list.length > 4) {
          this.publish?.({ type: 'tickets', projectId, tickets: p.crew.store.ticketRows() })
        } else {
          for (const cid of list) {
            const ticket = p.crew.store.ticket(cid)
            if (ticket) this.publish?.({ type: 'ticket', projectId, ticket })
          }
        }
        this.publish?.({ type: 'project', project: this.summary(projectId) })
      } catch (err) {
        if (!/not open/i.test(err?.message ?? '')) throw err
      }
    }
  }

  attach(row) {
    const allow = JSON.parse(row.allow).filter(supportedWorker)
    const worker = allow.includes(row.worker) ? row.worker : ''
    const concurrency = Number.isSafeInteger(row.concurrency) && row.concurrency >= 1 ? row.concurrency : null
    const implicit = Boolean(row.implicit)
    if (JSON.stringify(allow) !== row.allow || worker !== row.worker) {
      this.db.prepare('UPDATE projects SET allow=?,worker=? WHERE id=?').run(JSON.stringify(allow), worker, row.id)
    }
    const p = { ...row, allow, worker, concurrency, implicit }
    mkdirSync(dirname(ticketsPath(p.id)), { recursive: true })
    const store = new Store(false, ticketsPath(p.id))
    p.crew = new Crew(store, this.slots, () => ({ ...p, ...this.roster.effective(p) }))
    this.entries.set(p.id, p)
    this.slots?.setLimit?.(p.id, this.roster.effective(p).concurrency)
    store.onChange = cid => this.markTicketChanged(p.id, cid)
    return p
  }

  async recover(reason) {
    this.slots.paused = true
    for (const row of this.db.prepare('SELECT * FROM projects ORDER BY created').all()) await this.attach(row).crew.recover(reason)
    const queued = this.crews().flatMap(crew => crew.store.stmt("SELECT c.*,r.started FROM conversations c JOIN turns r ON r.cid=c.id AND r.turn=c.turn WHERE c.status='queued'").all().map(c => ({ crew, c })))
    for (const { crew, c } of queued.sort((a, b) => a.c.started - b.c.started)) this.slots.reserve(crew, c)
    this.slots.paused = false
    this.slots.drain()
    this.reconcileQueue()
  }

  reconcileQueue() {
    let work = false
    for (const p of this.entries.values()) {
      const scope = this.slots.scopeOf(p.crew)
      const pool = this.slots.pool(scope, p.crew)
      for (const [cid] of pool.active) {
        work = true
        const c = p.crew.store.stmt('SELECT status FROM conversations WHERE id=?').get(cid)
        if (c && c.status !== 'running') this.slots.release(cid)
      }
      const hasQueued = pool.queue.size > 0 || Boolean(p.crew.store.stmt("SELECT 1 FROM conversations WHERE status='queued' LIMIT 1").get())
      if (!hasQueued) continue
      work = true
      const queued = p.crew.store.stmt("SELECT c.id,c.name,c.turn,r.started FROM conversations c JOIN turns r ON r.cid=c.id AND r.turn=c.turn WHERE c.status='queued' ORDER BY r.started ASC, r.rowid ASC, c.rowid ASC").all()
      for (const c of queued) {
        if (pool.active.has(c.id) || pool.queue.has(c.id)) continue
        this.slots.reserve(p.crew, c)
      }
    }
    if (work) this.slots.drain()
  }

  startReconciler() {
    if (this._reconcileTimer) return
    this._reconcileTimer = setInterval(() => {
      if (this.slots.paused) return
      this.reconcileQueue()
    }, 3000)
    this._reconcileTimer.unref()
  }

  stopReconciler() {
    if (this._reconcileTimer) {
      clearInterval(this._reconcileTimer)
      this._reconcileTimer = null
    }
  }

  ensureImplicit(cwd, precomputedRoot = null) {
    const repoPath = precomputedRoot ? canonical(precomputedRoot) : workspaceRoot(cwd)
    if (!validProjectRoot(repoPath)) throw new Error('Choose a project directory separate from broco data')
    const global = this.roster?.read?.('global')
    const globalAllow = (global?.allow ?? []).filter(supportedWorker)
    if (!globalAllow.length) throw new Error(NO_PROJECT_OR_GLOBAL)
    const existing = [...this.entries.values()].find(item => samePath(item.repoPath, repoPath))
    if (existing) return existing
    const worker = globalAllow.includes(global.worker) ? global.worker : globalAllow[0]
    const key = randomUUID()
    const name = basename(repoPath)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('INSERT INTO projects (id,name,repoPath,created,allow,worker,concurrency,implicit) VALUES (?,?,?,?,?,?,?,1)').run(
        key, name, repoPath, Date.now(), JSON.stringify(globalAllow), worker, null
      )
      this.db.prepare('INSERT INTO roster_settings VALUES (?,?,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,data=excluded.data').run(
        key, 1, JSON.stringify({ entries: {}, rules: [], inheritPolicy: true })
      )
      this.db.exec('COMMIT')
    } catch (err) { this.db.exec('ROLLBACK'); throw err }
    const p = this.attach(this.db.prepare('SELECT * FROM projects WHERE id=?').get(key))
    if (!this.hasListeners || this.hasListeners()) {
      this.publish?.({ type: 'project', project: this.summary(p.id) })
    }
    return p
  }

  register(cwd, allow, worker, opts = {}) {
    const { claudeMd, agentsMd, host, managerMode = false, concurrency } = opts ?? {}
    const wantAgentsMd = agentsMd !== undefined ? agentsMd !== false : claudeMd !== false
    const repoPath = realpathSync.native(cwd)
    if (!validProjectRoot(repoPath)) throw new Error('Choose a project directory separate from broco data')
    if (wantAgentsMd) resolveAgentsDocPath(repoPath, { host })
    const id = binding(repoPath)
    let p = id === null ? [...this.entries.values()].find(p => samePath(p.repoPath, repoPath)) : this.get(id)
    if (p && !samePath(p.repoPath, repoPath) && existsSync(p.repoPath)) throw new Error('Project ID already bound to ' + p.repoPath)
    const global = this.roster.read('global')
    const wasImplicit = Boolean(p?.implicit)
    const currentPolicy = p ? this.roster.effective(p) : (global.allow?.length ? global : undefined)
    const inheritNew = (!p || wasImplicit) && allow === undefined && worker === undefined && Boolean(global.allow?.length)
    const settings = workerPolicy(allow, worker, currentPolicy)
    const entries = p ? this.roster.effective(p).entries : global.entries
    if (settings.allow.some(id => id.startsWith('custom:') && !entries[id]?.template)) throw new Error('Configure and test custom workers in broco ui first')
    let nextConcurrency = p?.concurrency ?? null
    if (concurrency !== undefined) {
      if (concurrency === null || concurrency === 'inherit') nextConcurrency = null
      else {
        const n = typeof concurrency === 'string' && /^\d+$/.test(concurrency.trim()) ? Number(concurrency.trim()) : concurrency
        if (!Number.isSafeInteger(n) || n < 1 || n > 64) throw new Error('Concurrency must be an integer between 1 and 64')
        nextConcurrency = n
      }
    }
    const key = p?.id ?? randomUUID()
    const name = basename(repoPath)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('INSERT INTO projects (id,name,repoPath,created,allow,worker,concurrency,implicit) VALUES (?,?,?,?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET repoPath=excluded.repoPath,name=excluded.name,allow=excluded.allow,worker=excluded.worker,concurrency=excluded.concurrency,implicit=0').run(key, name, repoPath, Date.now(), JSON.stringify(settings.allow), settings.worker, nextConcurrency)
      bind(repoPath, key)
      this.db.exec('COMMIT')
    } catch (err) { this.db.exec('ROLLBACK'); throw err }
    if (p) Object.assign(p, { name, repoPath, ...settings, concurrency: nextConcurrency, implicit: false })
    else p = this.attach(this.db.prepare('SELECT * FROM projects WHERE id=?').get(key))
    if (inheritNew && !wasImplicit) {
      this.db.prepare('INSERT INTO roster_settings VALUES (?,?,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,data=excluded.data').run(p.id, 1, JSON.stringify({ entries: {}, rules: [], inheritPolicy: true }))
    }
    if (allow !== undefined || worker !== undefined || concurrency !== undefined) {
      const local = this.roster.read(p.id)
      const { revision, ...data } = local
      let dirty = false
      if ((allow !== undefined || worker !== undefined) && data.inheritPolicy) { data.inheritPolicy = false; dirty = true }
      if (concurrency !== undefined) {
        if (nextConcurrency === null) delete data.concurrency
        else data.concurrency = nextConcurrency
        dirty = true
      }
      if (dirty) this.db.prepare('INSERT INTO roster_settings VALUES (?,?,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,data=excluded.data').run(p.id, revision + 1, JSON.stringify(data))
    }
    this.slots?.setLimit?.(p.id, this.roster.effective(p).concurrency)
    const doc = wantAgentsMd ? ensureAgentsMd(repoPath, { host, managerMode: !!managerMode }) : null
    const project = this.summary(p.id)
    if (!this.hasListeners || this.hasListeners()) {
      this.publish?.({ type: 'project', project })
    }
    return doc ? { ...project, agentsMd: doc, claudeMd: doc } : project
  }

  uninit(cwd, opts = {}) {
    const repoPath = realpathSync.native(cwd)
    const wantAgentsMd = opts?.agentsMd !== undefined ? opts.agentsMd !== false : opts?.claudeMd !== false
    if (wantAgentsMd) resolveAgentsDocPath(repoPath, { host: opts?.host })
    const markerDir = join(repoPath, '.broco')
    const legacyDir = join(repoPath, '.cc-bro')
    const legacyIdFile = join(legacyDir, 'project-id')
    const hasBrocoId = Boolean(info(join(markerDir, 'project-id'))?.isFile())
    const hasLegacyId = Boolean(info(legacyDir)?.isDirectory() && info(legacyIdFile)?.isFile())
    const id = binding(repoPath)
    const p = (id && this.entries.get(id)) || [...this.entries.values()].find(x => samePath(x.repoPath, repoPath)) || null
    if (p) {
      const active = p.crew.store.stmt("SELECT count(*) AS n FROM conversations WHERE status IN ('queued','running')").get().n
      if (active > 0) throw new Error('Stop running or queued tickets before uninitializing this project')
    }
    const complete = () => {
      if (p) {
        this.db.exec('BEGIN IMMEDIATE')
        try {
          this.db.prepare('DELETE FROM projects WHERE id=?').run(p.id)
          this.db.prepare('DELETE FROM roster_settings WHERE scope=?').run(p.id)
          this.roster?.audit?.archiveScope?.(p.id)
          this.db.exec('COMMIT')
        } catch (err) { this.db.exec('ROLLBACK'); throw err }
        this._dirty.delete(p.id)
        this.slots?.setLimit?.(p.id, null)
        this.entries.delete(p.id)
        p.crew.store.db.close()
        if (!this.hasListeners || this.hasListeners()) {
          this.publish?.({ type: 'project-removed', projectId: p.id })
        }
      }
      const markerRemoved = !!info(markerDir)
      if (markerRemoved) rmSync(markerDir, { recursive: true, force: true })
      let legacyMarkerRemoved = false
      if (!hasBrocoId && hasLegacyId) {
        rmSync(legacyIdFile, { force: true })
        legacyMarkerRemoved = true
        try {
          const rest = readdirSync(legacyDir)
          if (rest.length === 0 || (rest.length === 1 && rest[0] === '.gitignore' && readFileSync(join(legacyDir, '.gitignore'), 'utf8').trim() === '*')) {
            rmSync(legacyDir, { recursive: true, force: true })
          }
        } catch {}
      }
      const doc = !wantAgentsMd
        ? { path: resolveAgentsDocPath(repoPath, { host: opts?.host }), file: basename(resolveAgentsDocPath(repoPath, { host: opts?.host })), action: 'skipped', removed: false }
        : removeAgentsMd(repoPath, { host: opts?.host })
      return { unregistered: !!p, projectId: p?.id ?? id ?? null, repoPath, markerRemoved: markerRemoved || legacyMarkerRemoved, legacyMarkerRemoved, agentsMd: doc, claudeMd: doc }
    }
    const hasLiveWorkers = Boolean(p && (
      p.crew.workers?.size > 0 ||
      p.crew.store.stmt('SELECT 1 FROM conversations WHERE worker_pid IS NOT NULL LIMIT 1').get()
    ))
    if (!hasLiveWorkers) return complete()
    return (async () => {
      if (typeof p.crew.releaseAll === 'function') {
        await p.crew.releaseAll()
      } else {
        for (const [cid, w] of [...(p.crew.workers?.entries() ?? [])]) {
          await p.crew.release({ id: cid }, w)
        }
        for (const c of p.crew.store.stmt('SELECT * FROM conversations WHERE worker_pid IS NOT NULL').all()) {
          await p.crew.release(c, p.crew.workers?.get(c.id))
        }
      }
      return complete()
    })()
  }

  get(id) {
    const p = this.entries.get(id)
    if (!p) throw new Error('Unknown project ID; check BROCO_HOME and run broco init')
    return p
  }

  context(cwd, { createImplicit = true, optional = false } = {}) {
    const path = realpathSync.native(cwd)
    let p
    for (let root = path; ; root = dirname(root)) {
      if (within(home, root)) break
      const id = binding(root)
      if (id !== null) {
        p = this.get(id)
        if (!samePath(p.repoPath, root)) this.register(root, undefined, undefined, { claudeMd: false })
        break
      }
      if (dirname(root) === root) break
    }
    if (!p) {
      p = [...this.entries.values()]
        .filter(item => !item.implicit && within(path, item.repoPath))
        .sort((a, b) => b.repoPath.length - a.repoPath.length)[0]
    }
    if (!p && within(path, home)) {
      p = [...this.entries.values()].find(project =>
        project.crew.store.stmt('SELECT DISTINCT worktree FROM collaboration WHERE worktree IS NOT NULL').all().some(row => within(path, row.worktree)))
    }
    if (!p) {
      const wsRoot = workspaceRoot(path)
      const gitBounded = !samePath(wsRoot, path)
      p = [...this.entries.values()].find(item => samePath(item.repoPath, wsRoot))
      if (!p && !gitBounded) {
        p = [...this.entries.values()]
          .filter(item => item.implicit && within(path, item.repoPath))
          .sort((a, b) => b.repoPath.length - a.repoPath.length)[0]
      }
      if (!p) {
        if (!createImplicit) {
          if (optional) {
            const globalAllow = (this.roster?.read?.('global')?.allow ?? []).filter(supportedWorker)
            return { found: false, projectId: null, database: null, defaultCwd: wsRoot, implicit: false, globalConfigured: globalAllow.length > 0 }
          }
          throw new Error(NO_PROJECT_OR_GLOBAL)
        }
        p = this.ensureImplicit(path, wsRoot)
      }
    }
    return { found: true, projectId: p.id, database: ticketsPath(p.id), defaultCwd: p.repoPath, implicit: Boolean(p.implicit), globalConfigured: true }
  }

  summary(id) {
    const p = this.get(id)
    const counts = { queued: 0, working: 0, review: 0, done: 0 }
    let attention = 0, runningCount = 0, updated = p.created
    for (const r of p.crew.store.stmt('SELECT stage,flag,count(*) AS n,max(updated) AS updated FROM tickets GROUP BY stage,flag').all()) {
      counts[r.stage] += r.n
      if (r.stage === 'working' && !r.flag) runningCount += r.n
      if (r.flag || r.stage === 'review') attention += r.n
      updated = Math.max(updated, r.updated)
    }
    const policy = this.roster.effective(p)
    return { id, name: p.name, repoPath: p.repoPath, implicit: Boolean(p.implicit), allow: policy.allow, worker: policy.worker, concurrency: policy.concurrency, counts, runningCount, attention, updatedAt: new Date(updated).toISOString() }
  }

  projectStatus(id) {
    const p = this.get(id)
    const base = this.summary(id)
    const store = p.crew.store
    let errorCount = 0, stoppedCount = 0
    for (const r of store.stmt("SELECT flag, count(*) AS n FROM tickets WHERE flag IN ('error','stopped') GROUP BY flag").all()) {
      if (r.flag === 'error') errorCount += r.n
      if (r.flag === 'stopped') stoppedCount += r.n
    }
    const activeNames = store.stmt("SELECT name FROM conversations WHERE status='running' ORDER BY name").all().map(r => r.name)
    const queuedNames = store.stmt("SELECT c.name FROM conversations c LEFT JOIN turns r ON r.cid=c.id AND r.turn=c.turn WHERE c.status='queued' ORDER BY r.started ASC, r.rowid ASC, c.rowid ASC").all().map(r => r.name)
    const batches = listBatches(store).map(b => ({
      prefix: b.prefix,
      title: b.title,
      count: b.count,
      counts: b.counts,
      finished: b.finished
    }))
    const worktreeRows = store.stmt('SELECT m.worktree, t.stage FROM collaboration m JOIN tickets t ON t.cid=m.cid WHERE m.worktree IS NOT NULL').all()
    let retainedWorktrees = 0, cleanableWorktrees = 0
    for (const row of worktreeRows) {
      if (existsSync(row.worktree)) {
        retainedWorktrees += 1
        if (row.stage === 'done') cleanableWorktrees += 1
      }
    }
    return {
      ...base,
      errorCount,
      stoppedCount,
      activeNames,
      queuedNames,
      batches,
      activeBatches: batches.filter(b => !b.finished),
      retainedWorktrees,
      cleanableWorktrees
    }
  }

  statusSnapshot({ projectId = null, cwd = null, all = false } = {}) {
    let resolvedId = projectId
    if (!resolvedId && cwd) {
      try { resolvedId = this.context(cwd, { createImplicit: false }).projectId } catch { resolvedId = null }
    }
    const project = resolvedId && this.entries.has(resolvedId) ? this.projectStatus(resolvedId) : null
    const summaries = this.list()
    const projects = all ? [...this.entries.keys()].map(id => this.projectStatus(id)) : summaries
    const totals = {
      projects: summaries.length,
      running: summaries.reduce((n, s) => n + (s.runningCount ?? 0), 0),
      queued: summaries.reduce((n, s) => n + (s.counts?.queued ?? 0), 0),
      review: summaries.reduce((n, s) => n + (s.counts?.review ?? 0), 0),
      done: summaries.reduce((n, s) => n + (s.counts?.done ?? 0), 0),
      attention: summaries.reduce((n, s) => n + (s.attention ?? 0), 0)
    }
    const rs = this.db.prepare('SELECT * FROM runner_state WHERE id=1').get() ?? null
    const runnerState = rs ? {
      pid: rs.pid ?? null,
      ppid: rs.ppid ?? null,
      startedAt: rs.started ? new Date(rs.started).toISOString() : null,
      startedLocal: rs.started ? formatDateTime(rs.started) : null,
      lastStopReason: rs.stop_reason ?? null,
      webPort: rs.web_port ?? null
    } : null
    return { project, projects, totals, runnerState }
  }

  list() { return [...this.entries.keys()].map(id => this.summary(id)) }
  crews() { return [...this.entries.values()].map(p => p.crew) }
}
