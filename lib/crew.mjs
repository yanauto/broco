import { executable } from './cli-process.mjs'
import { detectCli } from './detect.mjs'
import { hiddenModel, matchModel, modelCapabilities } from './model-catalog.mjs'
import { describeAttachments, snapshotAttachments, piImages } from './attachments.mjs'
import { tight } from './quota.mjs'
import { supportedWorker } from './worker-policy.mjs'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { baseline, changes, changesAsync, createTree, verifyTree } from './worktree.mjs'
import { directory } from './directories.mjs'
import { setTimeout as sleep } from 'node:timers/promises'
import { withModelEnvironment } from './model-env.mjs'
import { nativeTurn } from './native.mjs'
import { streamTurn } from './stream-workers.mjs'
import { Pi, providerOf } from './pi.mjs'
import { platform } from './platform/index.mjs'
import { cachedCatalog, formatQueuedActivity } from './store.mjs'

const { owned, reap } = platform

const SESSION_UNBOUND_WARNING = '上一轮未建立原生会话，工人看不到上一轮原题；请确认本次消息包含完整题目或用 retry 重跑 / No prior native session was established; worker cannot see earlier failed prompt unless resent.'

const PROVIDER_VENDORS = {
  codex: 'openai',
  claude: 'anthropic',
  agy: 'google',
  'cursor-agent': 'cursor',
  'pi:openai': 'openai',
  'pi:openai-codex': 'openai',
  'pi:anthropic': 'anthropic',
  'pi:google': 'google',
  'pi:google-antigravity': 'google',
  'pi:google-gemini-cli': 'google',
  'pi:gemini': 'google',
  'pi:deepseek': 'deepseek',
  'pi:zai': 'zhipu',
  'pi:zai-coding-cn': 'zhipu',
  'pi:zhipu': 'zhipu',
  'pi:moonshot': 'moonshot',
  'pi:kimi': 'moonshot',
  'pi:xai': 'xai',
  'pi:alibaba': 'alibaba',
  'pi:qwen': 'alibaba',
  'pi:dashscope': 'alibaba',
  'custom:codex-json': 'openai',
  'custom:gemini': 'google'
}

export function workerVendor(workerId, model = null, catalog = cachedCatalog()) {
  if (typeof model === 'string' && model && model !== workerId) {
    const matched = matchModel(model, catalog)
    if (matched?.vendor) return matched.vendor.toLowerCase()
  }
  if (typeof workerId !== 'string' || !workerId) return null
  if (Object.hasOwn(PROVIDER_VENDORS, workerId)) return PROVIDER_VENDORS[workerId]
  if (workerId.startsWith('pi:')) return workerId.slice(3).toLowerCase()
  return workerId.toLowerCase()
}

function observedCooldown(store, provider) {
  const row = store.stmt("SELECT t.problem,t.finished FROM turns t JOIN conversations c ON c.id=t.cid WHERE c.provider=? AND json_extract(t.problem,'$.class') IN ('quota','region','auth') ORDER BY t.finished DESC LIMIT 1").get(provider)
  if (!row) return null
  const recovered = store.stmt("SELECT coalesce(max(t.finished),0) AS at FROM turns t JOIN conversations c ON c.id=t.cid WHERE c.provider=? AND t.status='done'").get(provider)?.at ?? 0
  if (recovered >= row.finished) return null
  const problem = JSON.parse(row.problem)
  const fresh = problem.resetsAt ? Date.parse(problem.resetsAt) > Date.now() : Date.now() - row.finished < 6 * 3600e3
  return fresh ? problem : null
}

export function normalizeAgyModel(model, effort, listedIds = []) {
  if (typeof model !== 'string' || !model || model === 'agy') return model
  const base = model.replace(/-(?:off|none|minimal|low|medium|high|xhigh|extra-high|max|ultra)$/, '')
  const hadSuffix = base !== model
  const isGeminiFamily = /^gemini-/i.test(base) && !/^gemini-pro-orchestrator\b/i.test(base)
  if (!effort) {
    if (!isGeminiFamily || hadSuffix) return model
    if (listedIds.includes(model)) return model
    if (listedIds.length > 0) return listedIds.find(id => id === base + '-medium') ?? listedIds.find(id => id.startsWith(base + '-')) ?? (base + '-medium')
    return base + '-medium'
  }
  const candidate = base + '-' + effort
  if (listedIds.length > 0) {
    if (listedIds.includes(candidate)) return candidate
    if (listedIds.includes(model) && !hadSuffix) return model
  }
  if (hadSuffix || isGeminiFamily) return candidate
  return model
}

export function activity(e) {
  if (e.type === 'tool_execution_start') {
    const target = e.args?.path ?? e.args?.command ?? ''
    return e.toolName + (target ? ' ' + target : '')
  }
  if (e.type === 'tool_execution_end') return e.toolName + (e.isError ? ' failed' : ' finished')
  if (e.type === 'auto_retry_start') return 'Retrying provider request'
  if (e.type === 'auto_compaction_start') return 'Compacting history'
  if (e.type === 'message_update') {
    const delta = e.assistantMessageEvent?.type
    if (delta === 'thinking_start' || delta === 'thinking_delta') return 'Thinking'
    if (delta === 'text_start' || delta === 'text_delta') return 'Writing reply'
  }
  if (e.type === 'agent_start') return 'Working'
  return ''
}

function messageText(message) {
  if (typeof message.content === 'string') return message.content
  return (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('')
}

export class Crew {
  constructor(store, slots, workerSettings = () => ({})) {
    this.store = store
    this.slots = slots
    this.workerSettings = workerSettings
    this.idleTimeoutMs = 10 * 60 * 1000
    this.idleTimers = new Map()
    this.refreshingFiles = new Set()
    this.onQueueChange = cid => store.onChange?.(cid)
    store.queueInfo = cid => slots?.queueInfo?.(cid) ?? null
    store.onStaleFinish = (id, turn) => slots?.release?.(id, turn)
    store.onDone = cid => {
      this.clearIdleTimer(cid)
      const w = this.workers.get(cid)
      if (w && !w.active && !w.stopping) {
        const c = store.stmt('SELECT * FROM conversations WHERE id=?').get(cid) ?? { id: cid }
        this.release(c, w).catch(() => {})
      }
    }
    store.onFinish = (id, next) => {
      const c = store.stmt('SELECT * FROM conversations WHERE id=?').get(id)
      if (c) {
        this.refreshFiles(c, false)
        if (!next) {
          this.environments.delete(id + ':' + (c.turn + 1))
          if (this.workers.has(id)) this.scheduleIdleRelease(id)
        }
      }
      slots?.release?.(id)
      if (next && c && slots.reserve(this, c)) this.serial(c.name, () => {
        const fresh = store.byName(c.name)
        if (fresh && fresh.turn === c.turn && fresh.status === 'queued') return this.dispatch(fresh)
        slots?.release?.(id, c.turn)
      }).catch(() => {
        slots?.release?.(id, c.turn)
      })
    }
    this.workers = new Map()
    this.queues = new Map()
    this.native = new Map()
    this.environments = new Map()
    this.detectWorker = (id, cwd) => detectCli(id, cwd)
    this.syncConcurrency()
  }

  clearIdleTimer(cid) {
    const timer = this.idleTimers.get(cid)
    if (timer) {
      clearTimeout(timer)
      this.idleTimers.delete(cid)
    }
  }

  scheduleIdleRelease(cid) {
    this.clearIdleTimer(cid)
    const w = this.workers.get(cid)
    if (!w || w.active || w.stopping || this.idleTimeoutMs <= 0) return
    const timer = setTimeout(() => {
      this.idleTimers.delete(cid)
      const current = this.workers.get(cid)
      if (!current || current !== w || current.active || current.stopping) return
      const c = this.store.stmt('SELECT * FROM conversations WHERE id=?').get(cid)
      if (!c || ['running', 'queued'].includes(c.status)) return
      this.serial(c.name, async () => {
        const fresh = this.store.byName(c.name)
        const target = this.workers.get(cid)
        if (!fresh || ['running', 'queued'].includes(fresh.status) || !target || target.active || target.stopping) return
        await this.release(fresh, target).catch(() => {})
      }).catch(() => {})
    }, this.idleTimeoutMs)
    timer.unref?.()
    this.idleTimers.set(cid, timer)
  }

  clearEnvFor(cid, turn) {
    if (turn !== undefined) {
      this.environments.delete(cid + ':' + turn)
      return
    }
    const prefix = cid + ':'
    for (const key of [...this.environments.keys()]) {
      if (key.startsWith(prefix)) this.environments.delete(key)
    }
  }

  syncConcurrency(explicit) {
    if (this.store.readOnly) return
    const configured = this.workerSettings?.()?.concurrency
    const limit = Number.isSafeInteger(explicit) && explicit >= 1
      ? explicit
      : Number.isSafeInteger(configured) && configured >= 1
        ? configured
        : (this.slots?.limitFor?.(this.slots.scopeOf(this), this) ?? this.slots?.limit ?? Number(process.env.BROCO_CONCURRENCY ?? 3))
    if (Number.isSafeInteger(limit) && limit >= 1) this.store.setMetaValue('concurrency', limit)
  }

  workingDirectory(c, meta = this.store.meta(c.id)) {
    return meta?.cwd ?? (meta?.worktree ? c.cwd : this.workerSettings().repoPath)
  }

  refreshFiles(c, live = false) {
    if (live && (this.refreshingFiles.has(c.id) || Date.now() - (c.filesChecked ?? 0) < 1200)) return
    c.filesChecked = Date.now()
    const m = this.store.meta(c.id)
    const before = JSON.parse(m?.baseline ?? 'null')
    if (!before) return
    const cwd = this.workingDirectory(c, m)
    if (live) {
      this.refreshingFiles.add(c.id)
      changesAsync(cwd, before)
        .then(files => {
          if (files && this.store.db.isOpen !== false) {
            try { this.store.stmt('UPDATE collaboration SET files=? WHERE cid=?').run(JSON.stringify(files), c.id) } catch {}
          }
        })
        .catch(() => {})
        .finally(() => { this.refreshingFiles.delete(c.id) })
      return
    }
    const files = changes(cwd, before)
    this.store.stmt('UPDATE collaboration SET files=? WHERE cid=?').run(JSON.stringify(files), c.id)
  }

  serial(name, fn) {
    const previous = this.queues.get(name) || Promise.resolve()
    const result = previous.catch(() => {}).then(fn)
    this.queues.set(name, result)
    const release = () => { if (this.queues.get(name) === result) this.queues.delete(name) }
    result.then(release, release)
    return result
  }

  async recover(reason) {
    reason ??= 'Runner interrupted; inspect work before resuming'
    const list = this.store.stmt("SELECT * FROM conversations WHERE worker_pid IS NOT NULL OR status='running'").all()
    for (const c of list) {
      for (const m of this.store.stmt("SELECT number,content,turn FROM messages WHERE cid=? AND kind='pending' ORDER BY number").all(c.id)) {
        this.store.follow(c, m.content, 'rejected', 'Runner interrupted; pi delivery unconfirmed', m.turn, m.number)
      }
      if (c.status === 'running') this.store.finish(c.id, c.turn, 'error', reason)
      try {
        await reap(this.store.marker(c.id))
        this.store.owner(c.id, null)
      } catch (err) {
        if (!this.store.finish(c.id, c.turn, 'error', err.message)) this.store.state(c.id, 'error', err.message)
      }
    }
  }

  async interruptRunning(reason = 'Runner interrupted; inspect work before resuming') {
    for (const timer of this.idleTimers.values()) clearTimeout(timer)
    this.idleTimers.clear()
    await Promise.allSettled([...this.queues.values()])
    const rows = this.store.stmt("SELECT * FROM conversations WHERE worker_pid IS NOT NULL OR status='running'").all()
    for (const c of rows) {
      if (c.status === 'queued') continue
      for (const m of this.store.stmt("SELECT number,content,turn FROM messages WHERE cid=? AND kind='pending' ORDER BY number").all(c.id)) {
        this.store.follow(c, m.content, 'rejected', 'Runner interrupted; pi delivery unconfirmed', m.turn, m.number)
      }
      const native = this.native.get(c.id)
      if (native) {
        const marked = owned(this.store.marker(c.id), [], c.worker_pid)
        this.store.finish(c.id, c.turn, 'error', reason)
        native.controller.abort()
        await reap(this.store.marker(c.id), marked).catch(() => {})
        await native.task.catch(() => {})
      } else {
        const w = this.workers.get(c.id)
        if (c.status === 'running') this.store.finish(c.id, c.turn, 'error', reason)
        await this.release(c, w).catch(() => {})
      }
      this.clearEnvFor(c.id)
      this.slots?.release?.(c.id)
    }
  }

  async releaseAll() {
    for (const timer of this.idleTimers.values()) clearTimeout(timer)
    this.idleTimers.clear()
    const cids = new Set([
      ...this.workers.keys(),
      ...this.store.stmt('SELECT id FROM conversations WHERE worker_pid IS NOT NULL').all().map(r => r.id)
    ])
    for (const cid of cids) {
      const c = this.store.stmt('SELECT * FROM conversations WHERE id=?').get(cid) ?? { id: cid }
      await this.release(c, this.workers.get(cid)).catch(() => {})
    }
  }

  record(c, w, e) {
    const s = this.store
    let label = activity(e).replace(/\s+/g, ' ').slice(0, 160)
    if (label === w.activity || !w.active) label = ''
    if (e.type === 'message_update' && !label) return
    s.transaction(() => {
      s.event(c.id, w.turn, e.type, e, label)
      if (e.type === 'tool_execution_end') this.refreshFiles(c, true)
      if (label) {
        w.activity = label
        s.state(c.id, 'running', label)
      }
      if (e.type === 'message_start' && e.message.role === 'user' && w.active) {
        if (w.initialSeen) {
          const item = w.steers.find(item => item.text === messageText(e.message))
          if (item) this.piOutcome(w, item, 'injected', 'pi delivered the message in this turn')
        }
        w.initialSeen = true
      }
      if (e.type === 'message_end' && e.message.role === 'assistant' && w.active) {
        const u = e.message.usage
        if (Number.isSafeInteger(u?.cacheRead)) s.event(c.id, w.turn, 'usage', { cachedInputTokens: u.cacheRead, inputTokens: u.input + u.cacheWrite + u.cacheRead }, 'Cached input: ' + u.cacheRead + ' tokens')
        w.sawAssistant = true
        w.replyId = s.assistant(c.id, w.turn, messageText(e.message))
        w.failure = e.message.stopReason === 'error' ? (e.message.errorMessage || 'Model request failed') : ''
        if (e.message.stopReason === 'length') w.failure = 'Model reached its output limit'
        if (e.message.stopReason === 'aborted') w.failure = 'Aborted by pi'
      }
      if (e.type === 'agent_settled' && w.active && !w.settling) {
        w.settling = true
        w.settled.resolve()
        if (w.stopping) return
        const failure = w.failure || (!w.sawAssistant && 'pi settled without an assistant message')
        const status = e.aborted ? 'stopped' : failure ? 'error' : 'done'
        const detail = e.aborted ? 'Stopped by pi' : failure || 'Waiting for input'
        const finish = () => {
          if (!w.active || w.stopping || w.exited) return
          w.active = false
          s.finish(c.id, w.turn, status, detail, w.replyId)
        }
        if (w.steers.length) this.drainPiSteers(w, status).then(finish)
        else finish()
      }
    })
  }

  piOutcome(w, item, outcome, reason) {
    const index = w.steers.indexOf(item)
    if (index < 0) return
    w.steers.splice(index, 1)
    const turn = item.c.turn + (outcome === 'queued' ? 1 : 0)
    const receipt = this.store.follow(item.c, item.text, outcome, reason, turn, item.number)
    if (outcome === 'queued') this.environments.set(item.c.id + ':' + turn, item.env)
    item.receipt.resolve(receipt)
  }

  steerPi(c, w, text, env) {
    const number = this.store.message(c.id, c.turn, 'pending', text)
    const item = { c, text, env, number, receipt: Promise.withResolvers() }
    w.steers.push(item)
    item.ack = w.command('steer', { message: text }).then(ack => {
      if (ack?.disposition === 'queued') return
      if (ack?.disposition !== 'handled') w.resetBeforeReuse = true
      this.piOutcome(w, item, 'rejected', 'pi did not confirm queueing for model delivery')
    }, err => this.piOutcome(w, item, err.declined && !w.stopping ? 'queued' : 'rejected', err.message))
    return { delivery: item.receipt.promise }
  }

  async drainPiSteers(w, status) {
    await Promise.all(w.steers.map(item => item.ack))
    if (!w.steers.length) return
    let remaining = []
    try {
      const cleared = await w.command('clear_queue')
      if (Array.isArray(cleared?.steering)) remaining = cleared.steering
      else w.resetBeforeReuse = true
    } catch { w.resetBeforeReuse = true }
    for (const item of [...w.steers]) {
      const index = remaining.indexOf(item.text)
      if (index >= 0 && status === 'done' && !w.stopping) {
        remaining.splice(index, 1)
        this.piOutcome(w, item, 'queued', 'Recovered undelivered steer from pi for next turn')
      } else this.piOutcome(w, item, 'rejected', 'pi turn ended without confirmed delivery')
    }
  }

  rejectMessage(cid, number, error) {
    this.store.stmt('UPDATE messages SET error=? WHERE cid=? AND number=?').run(error, cid, number)
  }

  async worker(c) {
    this.clearIdleTimer(c.id)
    let w = this.workers.get(c.id)
    if (w && !w.resetBeforeReuse) return w
    if (w) await this.release(c, w)
    else if (c.worker_pid !== null) await reap(this.store.marker(c.id))
    this.store.owner(c.id, 0)
    w = await Pi.launch(c, (worker, record) => this.record(c, worker, record), (worker, err) => {
      if (worker.expectedExit) return
      this.clearIdleTimer(c.id)
      for (const item of [...(worker.steers ?? [])]) this.piOutcome(worker, item, 'rejected', 'pi exited before confirming steer')
      if (!this.store.finish(c.id, worker.turn, 'error', err.message)) this.store.state(c.id, 'error', err.message)
      this.workers.delete(c.id)
      this.serial(c.name, async () => {
        if (this.workers.has(c.id) || this.store.byName(c.name).worker_pid !== worker.child.pid) return
        await reap(this.store.marker(c.id))
        this.store.owner(c.id, null)
      }).catch(error => this.store.state(c.id, 'error', error.message))
    }, this.store.sessions, this.store.marker(c.id))
    this.workers.set(c.id, w)
    this.store.owner(c.id, w.child.pid)
    const state = await w.command('get_state')
    const selected = state?.model
    const actual = selected?.provider + '/' + selected?.id
    if (selected?.provider !== c.provider.slice(3) || !selected.id || (c.model !== c.provider && actual !== c.model) || state.sessionId !== c.id) {
      throw new Error('pi did not select the requested model and session: ' + c.model)
    }
    if (c.thinking && state.thinkingLevel && state.thinkingLevel !== c.thinking) throw new Error('pi did not select the requested effort: ' + c.thinking)
    this.store.stmt("UPDATE conversations SET model=?,native_id=?,transport='pi-rpc' WHERE id=?").run(actual, state.sessionId, c.id)
    return w
  }

  async release(c, w) {
    this.clearIdleTimer(c.id)
    const marker = this.store.marker(c.id)
    const known = owned(marker, [], w?.child.pid)
    let forced = false
    if (w) {
      w.expectedExit = true
      w.stopping = true
      for (const item of [...(w.steers ?? [])]) this.piOutcome(w, item, 'rejected', 'Stopped before pi confirmed delivery')
      if (w.active && !w.exited) {
        try {
          const terminal = Promise.all([w.command('abort', {}, 4500), w.settled.promise])
          const ack = await Promise.race([terminal.then(() => true), sleep(5000, false, { ref: false })])
          forced = !ack
        } catch { forced = true }
      }
      w.child.stdin.end()
      await Promise.race([w.closed, sleep(600, null, { ref: false })])
    }
    await reap(marker, known)
    if (w && !w.exited) {
      const closed = await Promise.race([w.closed.then(() => true), sleep(1500, false, { ref: false })])
      if (!closed) throw new Error('Could not verify pi RPC process exit')
    }
    this.workers.delete(c.id)
    this.store.owner(c.id, null)
    return forced
  }

  async pickReviewWorker(p, { model, settings, catalog }) {
    const allow = settings.allow ?? []
    const writerVendor = workerVendor(p.provider, p.model, catalog)
    const crossCandidates = []
    for (const [index, id] of allow.entries()) {
      if (!supportedWorker(id) || id === p.provider) continue
      const entry = settings.entries?.[id] ?? {}
      const preModel = model || entry.model || null
      const preVendor = workerVendor(id, preModel, catalog)
      if (writerVendor && preVendor === writerVendor) continue
      crossCandidates.push({ id, index, entry })
    }
    if (!crossCandidates.length) {
      throw new Error('No cross-vendor reviewer available for ' + p.name + ' (writer: ' + p.provider + (writerVendor ? '/' + writerVendor : '') + '; allowed: ' + (allow.join(', ') || 'none') + '). Allow a worker from another vendor (e.g. broco allow <worker>) or pass --by <worker>.')
    }
    const probed = await Promise.all(crossCandidates.map(async c => {
      if (c.id.startsWith('custom:')) {
        const tpl = c.entry.template
        const inst = Boolean(tpl && executable(tpl.command))
        return {
          ...c,
          detected: {
            installed: inst,
            capability: 'degraded',
            loginStatus: inst ? 'ready' : 'not-installed',
            models: (c.entry.models ?? []).map(mid => ({ id: mid })),
            defaultModel: c.entry.model ?? null,
            quota: null
          }
        }
      }
      const detected = await this.detectWorker(c.id, settings.repoPath)
      return { ...c, detected }
    }))
    const codexQuotaShared = probed.find(x => x.id === 'codex')?.detected?.quota ?? null
    const ready = []
    const unavailable = []
    for (const item of probed) {
      const d = item.detected
      const effectiveModel = model || item.entry.model || d?.defaultModel || null
      const vendor = workerVendor(item.id, effectiveModel, catalog)
      if (writerVendor && vendor === writerVendor) {
        unavailable.push(item.id + ': same vendor (' + vendor + ')')
        continue
      }
      if (!d?.installed || d.loginStatus === 'not-installed') {
        unavailable.push(item.id + ': not-installed')
        continue
      }
      if (!['ready', 'not-required'].includes(d.loginStatus)) {
        unavailable.push(item.id + ': ' + (d.loginStatus || 'unknown'))
        continue
      }
      const visibleModels = (d.models ?? []).filter(m => !hiddenModel(m.id, item.entry.hiddenModels))
      if (!item.id.startsWith('custom:') && (d.models ?? []).length > 0 && visibleModels.length === 0) {
        unavailable.push(item.id + ': all models hidden')
        continue
      }
      const quota = d.quota ?? (item.id === 'pi:openai-codex' ? codexQuotaShared : null)
      const cooldown = observedCooldown(this.store, item.id)
      const avoid = tight(quota) || Boolean(cooldown)
      const plentiful = !avoid && Boolean(quota?.plentiful)
      const wins = Array.isArray(quota?.windows) ? quota.windows.filter(w => Number.isFinite(w.usedPercent)) : []
      const maxUsed = wins.length ? Math.max(...wins.map(w => w.usedPercent)) : 50
      const modelMatch = Boolean(model && visibleModels.some(m => m.id === model || (matchModel(m.id, catalog)?.id && matchModel(m.id, catalog)?.id === matchModel(model, catalog)?.id)))
      ready.push({
        id: item.id,
        index: item.index,
        modelMatch,
        avoid,
        plentiful,
        full: d.capability !== 'degraded',
        maxUsed
      })
    }
    if (!ready.length) {
      throw new Error('No ready cross-vendor reviewer available for ' + p.name + ' (writer: ' + p.provider + (writerVendor ? '/' + writerVendor : '') + '; allowed: ' + allow.join(', ') + '; unavailable: ' + unavailable.join(', ') + '). Sign in to another vendor CLI or specify --by <worker>.')
    }
    ready.sort((a, b) =>
      Number(b.modelMatch) - Number(a.modelMatch) ||
      Number(a.avoid) - Number(b.avoid) ||
      Number(b.plentiful) - Number(a.plentiful) ||
      Number(b.full) - Number(a.full) ||
      a.maxUsed - b.maxUsed ||
      a.index - b.index
    )
    return ready[0].id
  }

  async review({ name, by, model, effort, env }) {
    const explicitBy = typeof by === 'string' ? by.trim() : by
    if (explicitBy !== undefined && explicitBy !== null && explicitBy !== '') {
      if (!supportedWorker(explicitBy)) throw new Error('Choose --by from broco roster')
    }
    const p = this.store.byName(name)
    if (!p || !['review', 'done'].includes(this.store.ticket(p.id).status) || p.status !== 'idle') throw new Error('Review needs a completed writer turn')
    const settings = this.workerSettings()
    const catalog = cachedCatalog()
    let reviewer = explicitBy
    if (reviewer !== undefined && reviewer !== null && reviewer !== '') {
      if (reviewer === p.provider) throw new Error('Choose a different worker for review')
      const writerVendor = workerVendor(p.provider, p.model, catalog)
      const reviewerEntry = settings.entries?.[reviewer] ?? {}
      const reviewerVendor = workerVendor(reviewer, model || reviewerEntry.model || null, catalog)
      if (writerVendor && reviewerVendor === writerVendor) {
        throw new Error('Choose a different worker for review (same vendor: ' + writerVendor + ')')
      }
    } else {
      reviewer = await this.pickReviewWorker(p, { model, settings, catalog })
    }
    const m = this.store.meta(p.id)
    const files = JSON.parse(m?.files ?? 'null')
    const summary = files === null ? 'Unavailable' : files.map(f => f.status + ' ' + JSON.stringify(f.path)).join('\n') || 'No changes'
    const inputs = this.store.stmt("SELECT content FROM messages WHERE cid=? AND turn=? AND kind IN ('prompt','next','steer') AND error IS NULL ORDER BY number").all(p.id, p.turn)
    const text = ['Review the writer’s work. Inspect the changes in this directory; do not edit files. Report findings and test gaps.',
      'Writer: ' + name + ', turn ' + p.turn, 'Base commit: ' + (JSON.parse(m?.baseline ?? 'null')?.head ?? 'unavailable'),
      'Writer instructions for this turn:', ...inputs.map(i => i.content),
      'File codes describe added, modified or deleted paths since the ticket began; A includes untracked files and does not imply staging.', 'Changed files:', summary, 'Writer final reply:', this.store.reply(p.id, p.turn) ?? '(no reply)'].join('\n')
    const child = name + '-review-' + randomUUID().slice(0, 8)
    return this.say({ name: child, text, worker: reviewer, model, effort, env, title: 'Review: ' + name + ' #' + p.turn,
      defaultCwd: this.workingDirectory(p, m), cwd: m?.cwd ?? undefined }, { parent: p, meta: m })
  }

  async retry(name, { model, effort, worker, env } = {}) {
    const c = this.store.byName(name)
    if (!c) throw new Error('Unknown conversation: ' + name)
    if (c.turn < 1) throw new Error('Conversation has no turns to retry: ' + name)
    const lastTurn = this.store.stmt('SELECT * FROM turns WHERE cid=? AND turn=?').get(c.id, c.turn)
    if (['running', 'queued'].includes(c.status) || !['error', 'stopped'].includes(lastTurn?.status)) {
      throw new Error('Retry requires a failed or stopped turn: ' + name)
    }
    const promptRows = this.store.stmt("SELECT content FROM messages WHERE cid=? AND turn=? AND kind IN ('prompt','next') ORDER BY number").all(c.id, c.turn)
    const text = promptRows.map(r => r.content).join('\n\n')
    if (!text.trim()) throw new Error('No stored prompt to retry for ' + name)
    const savedExec = lastTurn?.execution ? JSON.parse(lastTurn.execution) : null
    const attachmentPaths = (savedExec?.attachments ?? []).map(f => f.path)
    if (worker !== undefined && worker !== c.provider) {
      if (c.native_id) throw new Error('This name is bound to ' + c.provider + '; use --from ' + name + ' with a new name to switch workers')
      const settings = this.workerSettings()
      if (!supportedWorker(worker) || !settings.allow.includes(worker)) throw new Error('Worker not allowed in this project: ' + worker)
      const previous = this.workers.get(c.id)
      if (previous) await this.release(c, previous)
      const nextEntry = settings.entries?.[worker] ?? {}
      const nextModel = model ?? nextEntry.model ?? worker
      const nextEffort = effort !== undefined ? (effort || null) : (nextEntry.effort ?? null)
      this.store.stmt('UPDATE conversations SET provider=?,model=?,thinking=? WHERE id=?').run(worker, nextModel, nextEffort, c.id)
    }
    const retriedTurn = c.turn
    const res = await this.say({
      name,
      text,
      attachments: attachmentPaths.length ? attachmentPaths : undefined,
      worker,
      model,
      effort,
      defaultCwd: this.workingDirectory(c),
      env,
      _retryingInitialTurn: retriedTurn === 1 && !c.native_id
    })
    if (res.delivery) {
      return { ...res, delivery: res.delivery.then(r => ({ ...r, retriedTurn })) }
    }
    return { ...res, retriedTurn }
  }

  async say(input, review) {
    if (input.from !== undefined) {
      if (this.store.byName(input.name)) throw new Error('--from requires a new conversation name')
      input = { ...input, text: this.store.handoff(input.from, input.text) }
    }
    this.syncConcurrency()
    const catalog = cachedCatalog()
    const settings = this.workerSettings(), current = this.store.byName(input.name)
    const contextWarning = current ? this.store.contextWarning(current.id, current.turn) : null
    const worker = input.worker ?? current?.provider ?? settings.worker
    const entry = settings.entries?.[worker] ?? {}
    const busy = current && ['running', 'queued'].includes(current.status)
    const unboundPriorSession = Boolean(current && !busy && current.turn >= 1 && !input.newTask && !current.native_id && !input._retryingInitialTurn)
    const agyExplicitSuffix = !busy && worker === 'agy' && typeof input.model === 'string'
      ? /-(off|none|minimal|low|medium|high|xhigh|extra-high|max|ultra)$/.exec(input.model)?.[1] ?? null
      : null
    let model = input.model ?? (busy ? current.model : entry.model || current?.model || worker)
    let effort = input.effort !== undefined ? (input.effort || null) : (agyExplicitSuffix ?? (busy ? current.thinking : entry.effort || current?.thinking || null))
    const requested = describeAttachments(input.attachments)
    let detect = null
    if (supportedWorker(worker) && settings.allow.includes(worker)) {
      detect = !busy && model === worker || requested.length ? await detectCli(worker, settings.repoPath) : null
      if (model === worker && detect?.defaultModel) { model = detect.defaultModel; effort ??= detect.defaultEffort }
      if (!busy && worker === 'agy') model = normalizeAgyModel(model, effort, detect?.models?.map(m => m.id) ?? [])
      let reason
      if (hiddenModel(model, entry.hiddenModels)) reason = 'Selected model is hidden; choose a visible model from roster'
      else if (entry.hiddenModels?.length && model === worker) reason = 'Cannot verify the CLI default against hidden models; choose an explicit visible model'
      if (requested.length) {
        const metadata = detect?.models.find(m => m.id === model) ?? { id: model }
        const caps = modelCapabilities(worker, metadata, matchModel(model, catalog))
        const allDetectSupport = model === worker && detect?.models?.length > 0 && requested.every(file =>
          detect.models.every(m => modelCapabilities(worker, m, matchModel(m.id, catalog)).input[file.kind] === true)
        )
        if (!allDetectSupport && requested.some(file => caps.input[file.kind] !== true)) reason = 'Selected CLI + model cannot accept this attachment (unsupported or unknown capability)'
      }
      if (reason) {
        if (busy) return { ...this.store.follow(current, input.text, 'rejected', reason), contextWarning }
        throw new Error(reason)
      }
    } else if (!busy && worker === 'agy') {
      model = normalizeAgyModel(model, effort)
    }
    const catalogEntry = matchModel(model, catalog)
    const detectedContext = detect?.models?.find(m => m.id === model)?.contextWindow
    const contextTokens = (Number.isSafeInteger(detectedContext) && detectedContext > 0 ? detectedContext : null)
      ?? (Number.isSafeInteger(catalogEntry?.modalities?.context_tokens) && catalogEntry.modalities.context_tokens > 0 ? catalogEntry.modalities.context_tokens : null)
      ?? 250000
    const context = { worker, model, effort, note: entry.note ?? '', rules: [...(settings.rules ?? []), ...(entry.rules ?? [])], capability: worker.startsWith('custom:') ? 'degraded' : 'full' }
    const execution = {
      model,
      thinking: effort,
      template: entry.template ?? null,
      attachments: [],
      contextTokens,
      note: context.note,
      rules: context.rules,
      capability: context.capability
    }
    const annotate = r => {
      const c = this.store.byName(input.name) ?? this.store.byName(r.name)
      const queue = c && (r.kind === 'queued' || c.status === 'queued') ? this.store.queueStatus(c.id) : null
      const reminders = [...context.rules.map(rule => 'Rule reminder: ' + rule), ...(unboundPriorSession ? [SESSION_UNBOUND_WARNING] : [])]
      const receipt = {
        ...r,
        ...context,
        contextWarning,
        queue,
        ...(unboundPriorSession ? { previousSessionBound: false, sessionWarning: SESSION_UNBOUND_WARNING } : {}),
        cwd: c ? this.workingDirectory(c) : null,
        reminders
      }
      if (c && r.outcome !== 'rejected') this.store.transaction(() => {
        this.store.event(c.id, r.turn, 'bro.dispatch', { note: context.note, rules: context.rules, capability: context.capability }, 'Worker: ' + worker + (effort ? ' · ' + effort : ''))
        if (r.outcome !== 'injected') {
          const row = this.store.stmt('SELECT execution FROM turns WHERE cid=? AND turn=?').get(c.id, r.turn)
          const saved = row?.execution ? JSON.parse(row.execution) : execution
          saved.attachments = [...new Map([...(saved.attachments ?? []), ...(execution.attachments ?? [])].map(f => [f.path, f])).values()]
          if (saved.contextTokens === undefined) saved.contextTokens = contextTokens
          saved.note = context.note
          saved.rules = context.rules
          saved.capability = context.capability
          this.store.stmt('UPDATE turns SET execution=? WHERE cid=? AND turn=?').run(JSON.stringify(saved), c.id, r.turn)
        }
        this.store.changed(c.id)
      })
      return receipt
    }
    const result = await this.acceptSay({ ...input, worker, model, effort, execution, requestedAttachments: requested }, review)
    return result.delivery ? { ...result, delivery: result.delivery.then(annotate) } : annotate(result)
  }

  async acceptSay({ name, text, model, effort, execution, requestedAttachments, worker, defaultCwd, cwd, title, env, worktree, from, newTask }, review) {
    if (typeof name !== 'string' || !name.trim() || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Invalid conversation name')
    let c = this.store.byName(name)
    if (from !== undefined && c) throw new Error('--from requires a new conversation name')
    const settings = this.workerSettings()
    const busy = c && ['running', 'queued'].includes(currentStatus(c))
    worker ??= c?.provider ?? settings.worker
    model ??= c?.model ?? worker
    let invalid
    if (typeof text !== 'string' || !text.trim()) invalid = 'Message is empty'
    else if (title !== undefined && (typeof title !== 'string' || !title.trim())) invalid = 'Title is empty'
    else if (!supportedWorker(worker) || !settings.allow.includes(worker)) invalid = 'Worker not allowed in this project: ' + worker
    else if (c && worker !== c.provider) invalid = 'This name is bound to ' + c.provider
    else if (typeof model !== 'string' || !model || /[\x00-\x1f\x7f]/.test(model)) invalid = 'Invalid model'
    else if (effort && (typeof effort !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(effort))) invalid = 'Invalid effort'
    else if (worker === 'codex' && model.includes('/')) invalid = 'Use --worker pi:<provider> for a provider/model ID'
    else if (newTask && c && (busy || !this.store.currentTask(c.id)?.outcome)) invalid = 'Record the current task with done before --new-task'
    else if (busy && (c.model !== model || c.thinking !== effort)) invalid = 'Cannot change model or effort during an active turn'
    else if (worker === 'cursor-agent' && effort && model === worker) invalid = 'Choose an explicit Cursor model when selecting effort'
    else if (worker.startsWith('custom:') && !execution.template) invalid = 'Configure and test this custom CLI first'
    else if (worker.startsWith('custom:') && effort && !execution.template.effortArgs.length) invalid = 'Custom CLI template has no effort argument'
    else if (worker.startsWith('custom:') && model !== worker && !execution.template.modelArgs.length) invalid = 'Custom CLI template has no model argument'
    else if (cwd !== undefined && (worktree || c && this.store.meta(c.id)?.worktree)) invalid = '--cwd cannot be combined with --worktree or an existing worktree session'
    else if (c && worktree && !this.store.meta(c.id)?.worktree) invalid = 'Choose --worktree when creating a new ticket'
    if (!invalid && cwd !== undefined) {
      try {
        cwd = directory(cwd, '--cwd')
        if (c && cwd !== directory(this.workingDirectory(c))) invalid = 'This name is bound to working directory ' + this.workingDirectory(c) + '; choose a new name to use --cwd with another directory'
      } catch (err) { invalid = err.message }
    }
    if (!invalid && worker.startsWith('pi:') && model !== worker) {
      try { if (providerOf(model) !== worker.slice(3)) invalid = 'Choose --model from the allowed pi provider' }
      catch (err) { invalid = err.message }
    }
    if (invalid) {
      if (busy) return this.store.follow(c, typeof text === 'string' ? text : '', 'rejected', invalid)
      throw new Error(invalid)
    }
    if (requestedAttachments?.length) {
      execution.attachments = snapshotAttachments(requestedAttachments, this.store.directory)
    }
    if (c && !busy && (c.model !== model || c.thinking !== effort)) {
      const previous = this.workers.get(c.id)
      if (previous) await this.release(c, previous)
      this.store.stmt('UPDATE conversations SET model=?,thinking=? WHERE id=?').run(model, effort, c.id)
      c = this.store.byName(name)
    }
    let queuedReason
    if (busy) {
      const pi = this.workers.get(c.id)
      if (!execution.attachments.length && pi?.active && !pi.stopping && !pi.settling) return this.steerPi(c, pi, text, env)
      const target = c.turn + 1
      const active = this.native.get(c.id)
      const steer = !execution.attachments.length && active && await active.ready.promise
      if (steer) {
        try {
          if (await steer(text)) return this.store.follow(c, text, 'injected', 'Codex acknowledged turn/steer')
        } catch (err) { return this.store.follow(c, text, 'rejected', 'Delivery unconfirmed: ' + err.message) }
      }
      queuedReason = steer ? 'Current turn declined steer' : 'Current turn does not accept steer'
      c = this.store.byName(name)
      if (['running', 'queued'].includes(c.status)) {
        const turn = c.turn === target && c.status === 'queued' ? target : c.turn + 1
        const key = c.id + ':' + turn
        if (!this.environments.has(key)) this.environments.set(key, env)
        return this.store.follow(c, text, 'queued', queuedReason, turn)
      }
      if (c.status !== 'idle') return this.store.follow(c, text, 'rejected', 'Previous turn did not complete')
    }
    const receipt = this.store.transaction(() => {
      if (!c) {
        const tree = worktree ? createTree(defaultCwd, this.store.directory, name) : review?.meta
        const workingCwd = directory(worktree ? tree.cwd : cwd ?? defaultCwd)
        c = this.store.create(name, workingCwd, model, title, effort, worker)
        this.store.stmt('INSERT INTO collaboration(cid,parent,parent_turn,worktree,branch,cwd) VALUES (?,?,?,?,?,?)').run(
          c.id, review?.parent.id ?? null, review?.parent.turn ?? null, tree?.worktree ?? null, tree?.branch ?? null, cwd ?? null)
        if (review) this.store.changed(review.parent.id)
      }
      const r = this.store.accept(c, text, title, newTask)
      this.store.stmt('UPDATE turns SET execution=? WHERE cid=? AND turn=?').run(JSON.stringify(execution), c.id, r.turn)
      if (queuedReason) {
        Object.assign(r, { outcome: 'queued', reason: queuedReason })
        this.store.event(c.id, r.turn, 'bro.interjection', r, 'queued: ' + queuedReason)
      }
      return r
    })
    c = this.store.byName(name)
    this.environments.set(c.id + ':' + c.turn, env)
    if (!this.slots.reserve(this, c)) {
      const queue = this.store.queueStatus(c.id)
      if (queue) this.store.state(c.id, 'queued', formatQueuedActivity(queue))
      return { ...receipt, kind: 'queued', queue }
    }
    try {
      await this.dispatch(c)
    } catch (err) {
      this.slots?.release?.(c.id, c.turn)
      throw err
    }
    return receipt
  }

  dispatch(c) {
    const key = c.id + ':' + c.turn
    const env = this.environments.get(key)
    this.environments.delete(key)
    return withModelEnvironment(env, () => this.startTurn(c)).catch(err => {
      try {
        this.store.finish(c.id, c.turn, 'error', err.message)
      } finally {
        this.slots?.release?.(c.id, c.turn)
      }
      throw err
    })
  }

  async startTurn(c) {
    this.clearIdleTimer(c.id)
    let messages = []
    try {
      const snapshot = this.store.stmt('SELECT execution FROM turns WHERE cid=? AND turn=?').get(c.id, c.turn)?.execution
      if (snapshot) c = { ...c, ...JSON.parse(snapshot) }
      messages = this.store.stmt("SELECT number,content FROM messages WHERE cid=? AND turn=? AND kind IN ('prompt','next') ORDER BY number").all(c.id, c.turn)
      if (!supportedWorker(c.provider)) throw new Error('Unsupported worker: ' + c.provider)
      if (!this.workerSettings().allow.includes(c.provider)) throw new Error('Worker no longer allowed: ' + c.provider)
      if (hiddenModel(c.model, this.workerSettings().entries?.[c.provider]?.hiddenModels)) throw new Error('Selected model is now hidden')
      const m = this.store.meta(c.id)
      c.cwd = directory(this.workingDirectory(c, m))
      if (m?.worktree) verifyTree(c.cwd, m.branch)
      if (!m?.baseline) {
        const initial = baseline(c.cwd)
        this.store.stmt('INSERT INTO collaboration(cid,baseline,branch) VALUES (?,?,?) ON CONFLICT(cid) DO UPDATE SET baseline=excluded.baseline,branch=coalesce(collaboration.branch,excluded.branch)').run(c.id, JSON.stringify(initial), initial?.branch ?? null)
      }
      this.store.claim(c)
      if (!c.provider.startsWith('pi:')) {
        const controller = new AbortController()
        this.store.working(c)
        const ready = Promise.withResolvers()
        const task = this.runNative(c, messages.map(m => m.content).join('\n\n'), controller, ready, m)
        this.native.set(c.id, { controller, task, ready })
        return
      }
      const w = await this.worker(c)
      Object.assign(w, { turn: c.turn, active: true, stopping: false, activity: '', sawAssistant: false, replyId: null, failure: '',
        initialSeen: false, settling: false, steers: [], settled: Promise.withResolvers() })
      this.store.working(c)
      const ack = await w.command('prompt', { message: messages.map(m => m.content).join('\n\n'), ...(c.attachments?.length ? { images: piImages(c.attachments) } : {}) })
      if (ack?.disposition === 'handled' && w.active) {
        w.active = false
        this.store.finish(c.id, w.turn, 'done', 'Input handled by pi')
      }
    } catch (err) {
      try {
        this.store.rejectDeferred(c.id, c.turn, err.message)
        for (const m of messages) this.rejectMessage(c.id, m.number, err.message)
        this.store.finish(c.id, c.turn, 'error', err.message)
      } finally {
        this.slots?.release?.(c.id, c.turn)
      }
      const failed = this.workers.get(c.id)
      if (failed) failed.active = false
      await this.release(c, failed)
      throw err
    }
  }

  async runNative(c, text, controller, ready, meta) {
    const s = this.store
    let reply, failure, problem = null, bound = c.native_id
    try {
      reply = await (c.provider === 'codex' ? nativeTurn : streamTurn)({
        ...c, text, session: c.native_id, marker: s.marker(c.id), signal: controller.signal,
        ready: ready.resolve, worktree: meta?.worktree, review: !!meta?.parent,
        owner: pid => s.owner(c.id, pid),
        bind: (id, transport) => {
          if (typeof id !== 'string' || !id || (bound && bound !== id)) throw new Error('Native worker returned a different session')
          bound = id
          s.stmt('UPDATE conversations SET native_id=?,transport=? WHERE id=?').run(id, transport, c.id)
        },
        event: (kind, payload, detail) => s.transaction(() => {
          if (kind === 'tool.completed' || (kind === 'item/completed' && ['fileChange', 'commandExecution'].includes(payload.type))) this.refreshFiles(c, true)
          s.event(c.id, c.turn, kind, payload, detail)
          if (detail) s.state(c.id, 'running', detail)
        })
      })
      if (!bound) throw new Error('Missing native session ID')
    } catch (err) { failure = err.message; problem = err.problem ?? null }
    finally {
      ready.resolve(null)
      await reap(s.marker(c.id)).catch(() => {})
      s.owner(c.id, null)
      this.native.delete(c.id)
    }
    const stopped = controller.signal.aborted
    s.transaction(() => s.finish(c.id, c.turn, stopped ? 'stopped' : failure ? 'error' : 'done',
      stopped ? 'Stopped by manager' : failure || 'Waiting for manager', !stopped && !failure ? s.assistant(c.id, c.turn, reply) : null, stopped ? null : problem))
  }

  async stop(name) {
    const c = this.store.byName(name)
    if (!c) throw new Error('Unknown conversation: ' + name)
    this.clearIdleTimer(c.id)
    this.clearEnvFor(c.id)
    try {
      if (c.status === 'queued') this.store.rejectDeferred(c.id, c.turn, 'Stopped before delivery')
      const native = this.native.get(c.id)
      if (native) {
        const marked = owned(this.store.marker(c.id), [], c.worker_pid)
        native.controller.abort()
        await reap(this.store.marker(c.id), marked)
        await native.task
        return { name, status: 'stopped', forced: false }
      }
      const w = this.workers.get(c.id)
      const marker = this.store.marker(c.id)
      if (!w && c.worker_pid === null && !existsSync(marker)) {
        const detail = 'Stopped; processes verified'
        if (!this.store.finish(c.id, c.turn, 'stopped', detail)) this.store.state(c.id, 'stopped', detail)
        this.store.event(c.id, c.turn, 'bro.stop', { forced: false }, detail)
        return { name, status: 'stopped', forced: false }
      }
      try {
        const forced = await this.release(c, w)
        const detail = forced ? 'Stopped by forced cleanup; processes verified' : 'Stopped; processes verified'
        if (!this.store.finish(c.id, c.turn, 'stopped', detail)) this.store.state(c.id, 'stopped', detail)
        this.store.event(c.id, c.turn, 'bro.stop', { forced }, detail)
        return { name, status: 'stopped', forced }
      } catch (err) {
        if (!this.store.finish(c.id, c.turn, 'error', err.message)) this.store.state(c.id, 'error', err.message)
        throw err
      }
    } finally {
      this.slots?.release?.(c.id)
    }
  }
}

function currentStatus(c) {
  return c?.status ?? ''
}
