import { execFileSync, spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { modelEnvironment } from './model-env.mjs'
import { parseRedactedJson, redactStderr, secretsFrom } from './pi-secrets.mjs'
import { classify, codexClass } from './problems.mjs'
import { codexQuota } from './quota.mjs'
import { HOST_SESSION_VARS } from './templates.mjs'

function commonGitDir(cwd) {
  try {
    const out = execFileSync('git', ['--no-optional-locks', '-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return out && out !== cwd ? out : null
  } catch { return null }
}

function channel(file, args, ctx, receive) {
  mkdirSync(dirname(ctx.marker), { recursive: true })
  const fd = openSync(ctx.marker, 'a', 0o600)
  let child, stderr = ''
  const env = { ...modelEnvironment(), BROCO_IN_WORKER: '1' }
  for (const key of HOST_SESSION_VARS) delete env[key]
  const rawSecrets = secretsFrom([], env)
  try {
    child = spawn(file, args, { cwd: ctx.cwd, env, stdio: ['pipe', 'pipe', 'pipe', fd], signal: ctx.signal })
  } finally { closeSync(fd) }
  ctx.owner(child.pid ?? null)
  let failure
  child.on('error', e => { failure = e })
  child.stdin.on('error', () => {})
  child.stderr.on('data', part => { stderr = (stderr + part.toString('utf8')).slice(-4096) })
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', line => {
    if (!line.trim() || failure) return
    try { receive(parseRedactedJson(line, rawSecrets)) }
    catch (err) { failure = err; child.kill() }
  })
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    rl.close()
    if (failure) return resolve(failure)
    if (code === 0) return resolve(null)
    const detail = redactStderr(stderr, env, rawSecrets)
    resolve(new Error(file + ' exited: ' + (signal || code) + (detail ? ': ' + detail : '')))
  }))
  return { child, closed }
}

async function streamed(ctx, file, args, input, parse) {
  const ch = channel(file, args, ctx, parse)
  ch.child.stdin.end(input)
  const error = await ch.closed
  if (error) throw error
}

function cached(ctx, n, total) {
  if (Number.isSafeInteger(n) && n >= 0) ctx.event('usage', { cachedInputTokens: n, inputTokens: Number.isSafeInteger(total) && total >= n ? total : null }, 'Cached input: ' + n + ' tokens')
}

async function codexExec(ctx) {
  if (ctx.attachments?.some(f => f.kind !== 'image')) throw new Error('Codex exec fallback cannot send audio attachments')
  let reply, finished = false, failed
  const gitDir = ctx.worktree && !ctx.review ? commonGitDir(ctx.cwd) : null
  const args = ['exec', ...(ctx.session ? ['resume'] : []), '--json']
  if (!ctx.session && (ctx.review || ctx.worktree)) args.push('--sandbox', ctx.review ? 'read-only' : 'workspace-write')
  if (gitDir) {
    if (!ctx.session) args.push('--add-dir', gitDir)
    args.push('-c', 'sandbox_workspace_write.writable_roots=' + JSON.stringify([gitDir]))
  }
  if (ctx.model !== 'codex') args.push('--model', ctx.model)
  if (ctx.thinking) args.push('-c', 'model_reasoning_effort=' + JSON.stringify(ctx.thinking))
  for (const file of ctx.attachments ?? []) args.push('--image', file.path)
  if (ctx.session) args.push(ctx.session)
  args.push('-')
  await streamed(ctx, 'codex', args, ctx.text, e => {
    if (e.type === 'thread.started') ctx.bind(e.thread_id, 'exec')
    if (e.type === 'item.completed' && e.item?.type === 'agent_message') reply = e.item.text
    else if (e.item?.type) ctx.event(e.type, {}, e.item.type + ': ' + e.type)
    if (e.type === 'turn.failed') failed = e.error?.message || 'Codex turn failed'
    if (e.type === 'turn.completed') { finished = true; cached(ctx, e.usage?.cached_input_tokens, e.usage?.input_tokens) }
  }).catch(err => { throw new Error(failed || err.message) })
  if (!finished || !reply || failed) throw new Error(failed || 'Codex exec returned no final result')
  return reply
}

function resetOf(snapshot) {
  const windows = [snapshot?.primary, snapshot?.secondary].filter(w => w && Number.isSafeInteger(w.resetsAt))
  return windows.sort((a, b) => b.usedPercent - a.usedPercent)[0]?.resetsAt ?? null
}

function failure(message, info, snapshot) {
  const cls = codexClass(info)
  return Object.assign(new Error(message), { problem: classify(message, { codex: info, resetsAt: cls === 'quota' ? resetOf(snapshot) : null }) })
}

async function appServer(ctx) {
  let next = 0, thread, reply, terminal = false, snapshot = null, lastError = null
  const quota = (raw, allowed) => {
    snapshot = { ...snapshot, ...Object.fromEntries(Object.entries(raw ?? {}).filter(([, v]) => v !== null && v !== undefined)) }
    const q = codexQuota(snapshot, allowed)
    if (q) ctx.event('quota', q, '')
  }
  const pending = new Map()
  const done = Promise.withResolvers()
  done.promise.catch(() => {})
  const ch = channel('codex', ['app-server'], ctx, e => {
    if (e.id !== undefined) {
      if (e.method) {
        send({ id: e.id, error: { code: -32601, message: 'No interactive manager attached' } })
        return
      }
      const waiter = pending.get(e.id)
      if (waiter) {
        pending.delete(e.id)
        if (e.error) waiter.reject(Object.assign(new Error(e.error.message), { rpcCode: e.error.code }))
        else waiter.resolve(e.result)
      }
      return
    }
    const p = e.params
    if (e.method === 'account/rateLimits/updated') { if (thread && !terminal) quota(p?.rateLimits); return }
    if (!thread || p?.threadId !== thread || terminal) return
    if (e.method === 'error') {
      lastError = p.error
      const info = p.error?.codexErrorInfo
      const exhausted = ['usageLimitExceeded', 'sessionBudgetExceeded'].includes(typeof info === 'string' ? info : '') || (codexClass(info) === 'quota' && codexQuota(snapshot)?.reached)
      ctx.event('provider.error', { codexErrorInfo: p.error?.codexErrorInfo ?? null, willRetry: !!p.willRetry }, (p.willRetry ? 'Provider error, Codex retrying: ' : 'Provider error: ') + String(p.error?.message ?? '').slice(0, 160))
      if (p.willRetry && exhausted) { terminal = true; done.reject(failure(p.error?.message || 'Codex quota exhausted', p.error?.codexErrorInfo, snapshot)) }
      return
    }
    if (e.method === 'thread/tokenUsage/updated') cached(ctx, p.tokenUsage?.last?.cachedInputTokens, p.tokenUsage?.last?.inputTokens)
    if (e.method === 'item/started' || e.method === 'item/completed') {
      const item = p.item
      if (item.type === 'agentMessage' && e.method === 'item/completed') reply = item.text
      const target = item.type === 'fileChange' ? item.changes?.map(f => f.path).join(', ') : ''
      ctx.event(e.method, { type: item.type }, [item.type, e.method.endsWith('started') ? 'started' : 'completed', target?.slice(0, 180)].filter(Boolean).join(' '))
    }
    if (e.method === 'turn/completed') {
      terminal = true
      if (p.turn.status === 'completed' && reply) done.resolve(reply)
      else {
        const error = p.turn.error ?? lastError
        done.reject(failure(error?.message || 'Codex turn ' + p.turn.status + ' without a final reply', error?.codexErrorInfo, snapshot))
      }
    }
  })
  const send = obj => ch.child.stdin.write(JSON.stringify(obj) + '\n')
  const closed = ch.closed.then(e => { throw e || new Error('Codex app-server closed') })
  closed.catch(() => {})
  async function request(method, params) {
    const id = ++next
    const waiter = Promise.withResolvers()
    pending.set(id, waiter)
    const timer = setTimeout(() => waiter.reject(new Error('Timed out: ' + method)), 30000)
    timer.unref?.()
    try { send({ id, method, params }); return await Promise.race([waiter.promise, closed]) }
    finally { clearTimeout(timer); pending.delete(id) }
  }
  try {
    try { await request('initialize', { clientInfo: { name: 'broco', version: '1.0.0' }, capabilities: {} }) }
    catch (err) { err.beforeThread = true; throw err }
    send({ method: 'initialized' })
    const params = { cwd: ctx.cwd, approvalPolicy: 'never' }
    if (ctx.review || ctx.worktree) params.sandbox = ctx.review ? 'read-only' : 'workspace-write'
    const gitDir = ctx.worktree && !ctx.review ? commonGitDir(ctx.cwd) : null
    if (gitDir) {
      params.writableRoots = [gitDir]
      params.config = { sandbox_workspace_write: { writable_roots: [gitDir] } }
    }
    if (ctx.model !== 'codex') params.model = ctx.model
    let res
    try {
      res = ctx.session ? await request('thread/resume', { ...params, threadId: ctx.session }) : await request('thread/start', params)
    } catch (err) {
      if (err.rpcCode === -32601) err.beforeThread = true
      throw err
    }
    thread = res.thread.id
    ctx.bind(thread, 'app-server')
    let timer
    try {
      const slow = new Promise(resolve => { timer = setTimeout(resolve, 5000, null); timer.unref?.() })
      const limits = await Promise.race([request('account/rateLimits/read', {}).catch(() => null), slow])
      if (limits) quota(limits.rateLimits, limits.ordinaryUsageAllowed)
    } finally { clearTimeout(timer) }
    if (!ctx.session) await request('thread/name/set', { threadId: thread, name: ctx.name })
    const started = await request('turn/start', { threadId: thread, ...(ctx.thinking ? { effort: ctx.thinking } : {}), input: [{ type: 'text', text: ctx.text, text_elements: [] }, ...(ctx.attachments ?? []).map(f => ({ type: f.kind === 'image' ? 'localImage' : 'localAudio', path: f.path }))] })
    const turn = started?.turn?.id
    ctx.ready(turn ? async text => {
      if (terminal) return false
      try {
        const res = await request('turn/steer', { threadId: thread, expectedTurnId: turn, input: [{ type: 'text', text, text_elements: [] }] })
        if (res?.turnId !== turn) throw new Error('Unconfirmed turn/steer acknowledgement')
        return true
      } catch (err) {
        if (err.rpcCode !== undefined) return false
        throw err
      }
    } : null)
    const result = await Promise.race([done.promise, closed])
    let after
    try {
      const slow = new Promise(resolve => { after = setTimeout(resolve, 2000, null); after.unref?.() })
      const limits = await Promise.race([request('account/rateLimits/read', {}).catch(() => null), slow])
      if (limits) quota(limits.rateLimits, limits.ordinaryUsageAllowed)
    } finally { clearTimeout(after) }
    return result
  } finally {
    ch.child.stdin.end()
    ch.child.kill()
    const kill = setTimeout(() => ch.child.kill('SIGKILL'), 2000)
    kill.unref?.()
    try { await ch.closed } finally { clearTimeout(kill) }
  }
}

export async function nativeTurn(ctx) {
  if (ctx.provider !== 'codex') throw new Error('Expected a codex worker')
  if (ctx.transport !== 'exec') {
    try { return await appServer(ctx) }
    catch (err) {
      if (!err.beforeThread || ctx.signal.aborted) throw err
      ctx.event('fallback', {}, 'App-server unavailable; using codex exec')
    }
  }
  ctx.ready(null)
  return codexExec(ctx)
}
