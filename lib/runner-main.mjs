import { mkdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { openDatabase } from './sqlite.mjs'
import { home, socketPath } from './paths.mjs'
import { Slots } from './slots.mjs'
import { Projects } from './projects.mjs'
import { Web } from './web.mjs'
import { CredentialProxies } from './credential-proxy.mjs'
import { batchDetail, dispatchMap, doneBatch, isBatch, retryBatch, stopBatch } from './map.mjs'
import { cleanWorktrees, diffWorktree } from './worktree.mjs'
import { gcAttachments } from './attachments.mjs'
import { summarize, ticketRecords } from './stats.mjs'
import { formatDateTime } from './time.mjs'
import { supportedWorker } from './worker-policy.mjs'

const RUNNER_PROTOCOL = 15
const MAX_RPC_BODY = 2 * 1024 * 1024

if (process.platform !== 'win32') process.umask(0o077)
mkdirSync(home, { recursive: true })
const lease = openDatabase(join(home, 'runner.lock'), { busyTimeout: 0 })
try { lease.exec('BEGIN EXCLUSIVE') }
catch (err) {
  if ((err.errcode & 0xff) !== 5) throw err
  process.exit(0)
}

const slots = new Slots(Number(process.env.BROCO_CONCURRENCY ?? 3))
const waiters = new Set()
let web
const publish = event => web?.publish(event)
const projects = new Projects(slots, publish, () => Boolean(web?.hasSubscribers()) || waiters.size > 0)
web = new Web(projects)
const proxies = new CredentialProxies()

function wakeWaiters(projectId = null, forceRetry = false) {
  for (const w of [...waiters]) {
    if (projectId === null || w.projectId === projectId) {
      try { w.check(forceRetry) } catch {}
    }
  }
}

projects.onTicketChange = projectId => wakeWaiters(projectId)

projects.db.exec('CREATE TABLE IF NOT EXISTS runner_state (id INTEGER PRIMARY KEY CHECK (id=1), pid INTEGER, ppid INTEGER, started INTEGER, stop_reason TEXT, stopped INTEGER, web_port INTEGER)')
const prevRunner = projects.db.prepare('SELECT * FROM runner_state WHERE id=1').get() ?? null
projects.db.prepare('INSERT INTO runner_state(id,pid,ppid,started,stop_reason,stopped) VALUES (1,?,?,?,NULL,NULL) ON CONFLICT(id) DO UPDATE SET pid=excluded.pid,ppid=excluded.ppid,started=excluded.started,stop_reason=NULL,stopped=NULL').run(process.pid, process.ppid, Date.now())

function recoverReason() {
  if (!prevRunner) return 'Runner interrupted; inspect work before resuming'
  const nowText = formatDateTime()
  if (prevRunner.stop_reason) {
    return 'Runner interrupted (' + prevRunner.stop_reason + ', runner pid ' + prevRunner.pid + '); recovered by pid ' + process.pid + ' at ' + nowText + '; inspect work before resuming'
  }
  return 'Runner interrupted: previous runner (pid ' + prevRunner.pid + ') exited unexpectedly without shutdown; recovered by pid ' + process.pid + ' at ' + nowText + '; inspect work before resuming'
}

await projects.recover(recoverReason())
projects.startReconciler()

const savedWebPort = projects.readWebPort()
if (savedWebPort) {
  web.port = savedWebPort
  await web.start().then(() => {
    if (web.boundPort) projects.saveWebPort(web.boundPort)
  }).catch(() => {})
}

async function readRpcBody(req) {
  const chunks = []
  let bytes = 0
  for await (const part of req) {
    const buf = Buffer.isBuffer(part) ? part : Buffer.from(part)
    bytes += buf.length
    if (bytes > MAX_RPC_BODY) throw new Error('RPC request exceeds 2 MiB')
    chunks.push(buf)
  }
  const text = chunks.length ? Buffer.concat(chunks, bytes).toString('utf8') : '{}'
  return JSON.parse(text)
}

function requireCrew(crew) {
  if (!crew) throw new Error('Project ID is required')
  return crew
}

function evaluateWait(crew, { name, turn, number }) {
  const store = crew.store
  if (isBatch(store, name)) {
    if (turn !== undefined && turn !== null) {
      throw new Error('Batch wait does not take a turn number; use broco wait ' + name)
    }
    const detail = batchDetail(store, name)
    if (!detail) throw new Error('Unknown batch: ' + name)
    if (!detail.finished) return { done: false }
    return { done: true, value: detail }
  }
  const c = store.byName(name)
  if (!c) throw new Error('Unknown conversation: ' + name)
  let targetTurn
  if (turn === undefined || turn === null) {
    if (c.turn < 1) throw new Error('Conversation has no turns yet: ' + name)
    targetTurn = c.turn
  } else {
    targetTurn = Number(turn)
  }
  if (!Number.isSafeInteger(targetTurn) || targetTurn < 1) throw new Error('Expected a positive turn number')
  if (number) {
    const msg = store.stmt('SELECT error FROM messages WHERE cid=? AND number=?').get(c.id, number)
    if (msg?.error) throw new Error(msg.error)
  }
  const result = store.result(c.id, targetTurn)
  if (['running', 'queued'].includes(result.status)) return { done: false }
  const taskRow = store.tasks(c.id).find(tk => targetTurn >= tk.startTurn && targetTurn <= tk.endTurn) ?? store.currentTask(c.id)
  const meta = store.meta(c.id)
  return {
    done: true,
    value: {
      name: c.name,
      task: taskRow?.task ?? null,
      worker: c.provider,
      model: c.model,
      cwd: crew.workingDirectory(c, meta),
      worktree: meta?.worktree ?? null,
      branch: meta?.branch ?? null,
      changedFiles: JSON.parse(meta?.files ?? 'null'),
      ...result
    }
  }
}

function waitForOutcome(projectId, crew, input, req) {
  const first = evaluateWait(crew, input)
  if (first.done) return Promise.resolve(first.value)
  const holdMs = Math.min(Math.max(500, Number(input.timeoutMs) || 25000), 30000)
  return new Promise((resolve, reject) => {
    let settled = false
    let timer = null
    const waiter = {
      projectId,
      check(forceRetry = false) {
        if (settled) return
        if (forceRetry || closing) {
          cleanup()
          resolve({ waiting: true })
          return
        }
        try {
          const outcome = evaluateWait(crew, input)
          if (outcome.done) {
            cleanup()
            resolve(outcome.value)
          }
        } catch (err) {
          cleanup()
          reject(err)
        }
      }
    }
    const onClose = () => {
      if (settled) return
      cleanup()
      resolve({ waiting: true })
    }
    function cleanup() {
      settled = true
      if (timer) clearTimeout(timer)
      waiters.delete(waiter)
      req.off('close', onClose)
    }
    timer = setTimeout(() => {
      if (settled) return
      cleanup()
      resolve({ waiting: true })
    }, holdMs)
    timer.unref?.()
    req.once('close', onClose)
    waiters.add(waiter)
  })
}

if (!socketPath.startsWith('\\\\.\\pipe\\')) rmSync(socketPath, { force: true })
let closing = false
const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  try {
    if (closing) throw new Error('Runner is shutting down')
    if (req.url === '/ready' && req.method === 'GET') {
      res.end(JSON.stringify({ pid: process.pid, protocol: RUNNER_PROTOCOL, credentialProxy: true }))
      return
    }
    if (req.method !== 'POST') throw new Error('Expected POST')
    const input = await readRpcBody(req)
    const crew = input.projectId ? projects.get(input.projectId).crew : null
    let reply
    if (req.url === '/ui') {
      const url = await web.start()
      if (web.boundPort) projects.saveWebPort(web.boundPort)
      reply = { url }
    } else if (req.url === '/status') {
      const snap = projects.statusSnapshot({ projectId: input.projectId ?? null, cwd: input.cwd ?? null, all: !!input.all })
      const proxyList = proxies.list()
      const startedMs = snap.runnerState?.startedAt ? Date.parse(snap.runnerState.startedAt) : null
      reply = {
        runner: {
          online: true,
          compatible: true,
          pid: process.pid,
          protocol: RUNNER_PROTOCOL,
          startedAt: snap.runnerState?.startedAt ?? null,
          startedLocal: snap.runnerState?.startedLocal ?? null,
          uptimeSec: startedMs ? Math.max(0, Math.floor((Date.now() - startedMs) / 1000)) : 0,
          lastStopReason: snap.runnerState?.lastStopReason ?? null,
          webUrl: web.origin ?? null,
          activeProxies: proxyList.length,
          proxies: proxyList
        },
        project: snap.project,
        projects: snap.projects,
        totals: snap.totals
      }
    } else if (req.url === '/proxy-open') reply = await proxies.open(input)
    else if (req.url === '/proxy-list') reply = proxies.list()
    else if (req.url === '/proxy-close') reply = await proxies.close(input.id)
    else if (req.url === '/register') reply = projects.register(input.cwd, input.allow, input.worker, { agentsMd: input.agentsMd, claudeMd: input.claudeMd, host: input.host, managerMode: input.managerMode, concurrency: input.concurrency })
    else if (req.url === '/unregister') reply = await projects.uninit(input.cwd, { agentsMd: input.agentsMd, claudeMd: input.claudeMd, host: input.host })
    else if (req.url === '/context') reply = projects.context(input.cwd, { createImplicit: input.createImplicit !== false, optional: !!input.optional })
    else if (req.url === '/roster') {
      if (input.global) {
        const globalCfg = projects.roster.read('global')
        const unconfigured = !(globalCfg.allow?.length)
        const raw = await projects.roster.list('global', unconfigured ? true : Boolean(input.all), { refresh: !!input.refresh })
        if (unconfigured) {
          raw.globalAllowConfigured = false
          raw.workers = raw.workers
            .filter(w => w.installed)
            .map(w => ({
              ...w,
              allowed: false,
              models: ['ready', 'not-required'].includes(w.loginStatus) ? w.models : []
            }))
          raw.warnings = [
            ...(raw.warnings ?? []),
            'Global allowlist is not configured yet. Run broco setup or broco allow <ids> --global.'
          ]
        }
        reply = raw
      } else {
        if (!input.projectId) throw new Error('Project ID is required')
        reply = await projects.roster.list(input.projectId, Boolean(input.all), { refresh: !!input.refresh })
      }
    } else if (req.url === '/stats') {
      reply = input.projectId ? summarize(ticketRecords(requireCrew(crew).store)) : projects.roster.records()
    } else if (req.url === '/defaults-proposal') reply = projects.roster.proposeDefaults(input.projectId, input.worker, input)
    else if (req.url === '/note-proposal') reply = projects.roster.propose(input.projectId, input.worker, input.note)
    else if (req.url === '/defaults-set') reply = projects.roster.setDefaults(input.scope, input.worker, { model: input.model, effort: input.effort, clear: !!input.clear }, input.actor ?? 'agent')
    else if (req.url === '/note-set') reply = projects.roster.setNote(input.scope, input.worker, input.note, input.actor ?? 'agent')
    else if (req.url === '/concurrency-set') reply = projects.roster.setConcurrency(input.scope, input.concurrency, input.actor ?? 'agent')
    else if (req.url === '/allow-set') reply = projects.roster.setAllow(input.scope, { allow: input.allow, add: input.add, remove: input.remove, defaultWorker: input.defaultWorker, inheritPolicy: input.inheritPolicy }, input.actor ?? 'agent')
    else if (req.url === '/rules-get') {
      if (input.worker && !supportedWorker(input.worker)) throw new Error('Unknown worker: ' + input.worker)
      const cfg = projects.roster.config(input.scope)
      const eff = cfg.effective
      reply = {
        scope: cfg.scope,
        rules: eff.rules ?? [],
        scopeRules: cfg.rules ?? [],
        rulesOverride: !!cfg.rulesOverride,
        ...(input.worker
          ? { worker: input.worker, workerRules: eff.entries?.[input.worker]?.rules ?? [] }
          : { workerRules: Object.fromEntries(Object.entries(eff.entries ?? {}).filter(([, e]) => e.rules?.length).map(([k, e]) => [k, e.rules])) })
      }
    }
    else if (req.url === '/rules-set') reply = projects.roster.setRules(input.scope, { add: input.add, remove: input.remove, clear: !!input.clear, worker: input.worker, rulesOverride: input.rulesOverride }, input.actor ?? 'agent')
    else if (req.url === '/hidden-models-set') reply = projects.roster.setHiddenModels(input.scope, input.worker, { hide: input.hide, unhide: input.unhide, clear: !!input.clear }, input.actor ?? 'agent')
    else if (req.url === '/audit-list') reply = projects.roster.auditList(input.scope, input.limit)
    else if (req.url === '/audit-undo') reply = projects.roster.undoAudit(input.id, { scope: input.scope, actor: input.actor ?? 'agent' })
    else if (req.url === '/say') {
      requireCrew(crew)
      input.defaultCwd = projects.get(input.projectId).repoPath
      reply = await crew.serial(input.name, () => crew.say(input))
      if (reply.delivery) reply = await reply.delivery
    } else if (req.url === '/retry') {
      requireCrew(crew)
      if (isBatch(crew.store, input.name)) {
        reply = await retryBatch(crew, input.name, { model: input.model, effort: input.effort, worker: input.worker, env: input.env })
      } else {
        reply = await crew.serial(input.name, () => crew.retry(input.name, { model: input.model, effort: input.effort, worker: input.worker, env: input.env }))
        if (reply.delivery) reply = await reply.delivery
      }
    } else if (req.url === '/map') {
      requireCrew(crew)
      input.defaultCwd = projects.get(input.projectId).repoPath
      reply = await dispatchMap(crew, input)
    } else if (req.url === '/review') {
      requireCrew(crew)
      reply = await crew.serial(input.name, () => crew.review({ ...input, by: input.by ?? null }))
    } else if (req.url === '/stop') {
      requireCrew(crew)
      reply = isBatch(crew.store, input.name)
        ? await stopBatch(crew, input.name)
        : await crew.serial(input.name, () => crew.stop(input.name))
    } else if (req.url === '/done') {
      requireCrew(crew)
      if (isBatch(crew.store, input.name)) {
        if (input.task !== undefined) throw new Error('--task applies to a single session, not a batch prefix')
        reply = doneBatch(crew.store, input.name, { result: input.result, why: input.why })
      } else {
        reply = await crew.serial(input.name, () => crew.store.done(input.name, { result: input.result, why: input.why, task: input.task }))
      }
    } else if (req.url === '/wait') {
      requireCrew(crew)
      reply = await waitForOutcome(input.projectId, crew, input, req)
    } else if (req.url === '/diff') {
      requireCrew(crew)
      const c = crew.store.byName(input.name)
      if (!c) throw new Error('Unknown conversation: ' + input.name)
      const meta = crew.store.meta(c.id)
      const targetCwd = crew.workingDirectory(c, meta)
      const diff = diffWorktree(targetCwd, meta?.baseline ?? null, { statOnly: !!input.statOnly })
      reply = {
        name: c.name,
        cwd: targetCwd,
        worktree: meta?.worktree ?? null,
        branch: meta?.branch ?? null,
        ...diff
      }
    } else if (req.url === '/clean') {
      requireCrew(crew)
      const proj = projects.get(input.projectId)
      const worktrees = cleanWorktrees(crew.store, proj.repoPath, {
        target: input.name ?? null,
        dryRun: !!input.dryRun,
        deleteBranch: !!input.deleteBranch,
        force: !!input.force
      })
      const attachments = input.name ? { removed: 0, freedBytes: 0, files: [] } : gcAttachments(crew.store, { dryRun: !!input.dryRun })
      reply = { ...worktrees, attachments }
    } else if (req.url === '/shutdown') {
      closing = true
      wakeWaiters(null, true)
      try { await stopWorkers({ callerPid: input.callerPid }) } catch (err) { closing = false; proxies.closed = false; slots.paused = false; slots.drain(); throw err }
      reply = { status: 'offline' }
      res.once('finish', () => server.close())
    } else throw new Error('Unknown command')
    if (!res.writableEnded) res.end(JSON.stringify(reply))
  } catch (err) {
    if (!res.headersSent) res.statusCode = 400
    if (!res.writableEnded) res.end(JSON.stringify({ error: err.message }))
  }
})

async function stopWorkers({ preserveQueued = false, signal, callerPid } = {}) {
  slots.paused = true
  projects.stopReconciler()
  wakeWaiters(null, true)
  const nowText = formatDateTime()
  const reason = signal
    ? 'Runner interrupted by ' + signal + ' (runner pid ' + process.pid + ' at ' + nowText + '); inspect work before resuming'
    : 'Stopped by manager'
  if (signal) {
    try { projects.db.prepare('UPDATE runner_state SET stop_reason=?,stopped=? WHERE id=1').run('signal:' + signal, Date.now()) } catch {}
  } else if (callerPid) {
    try { projects.db.prepare('UPDATE runner_state SET stop_reason=?,stopped=? WHERE id=1').run('shutdown-rpc:caller=' + callerPid, Date.now()) } catch {}
  } else {
    try { projects.db.prepare('UPDATE runner_state SET stop_reason=?,stopped=? WHERE id=1').run('shutdown-rpc', Date.now()) } catch {}
  }
  await proxies.closeAll()
  await web.close()
  for (const crew of projects.crews()) {
    if (preserveQueued && typeof crew.interruptRunning === 'function') {
      await crew.interruptRunning(reason)
      continue
    }
    await Promise.allSettled([...crew.queues.values()])
    for (const c of crew.store.stmt("SELECT * FROM conversations WHERE status IN ('queued','running')").all()) {
      if (preserveQueued && c.status === 'queued') continue
      await crew.stop(c.name)
    }
    if (typeof crew.releaseAll === 'function') await crew.releaseAll()
  }
}

async function shutdown(sig) {
  if (closing) return
  closing = true
  wakeWaiters(null, true)
  try { await stopWorkers({ preserveQueued: true, signal: sig }) }
  catch { process.exitCode = 1 }
  finally { server.close() }
}

server.on('close', () => {
  projects.stopReconciler()
  for (const crew of projects.crews()) crew.store.db.close()
  projects.db.close()
  lease.close()
})
server.listen(socketPath)
process.once('SIGTERM', () => shutdown('SIGTERM'))
process.once('SIGINT', () => shutdown('SIGINT'))
