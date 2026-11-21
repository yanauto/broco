import { outcomes } from './store.mjs'
import { formatDateTime } from './time.mjs'

export function formatShardPrompt(brief, { input, index, count, name }) {
  const vars = { input: String(input), index: String(index), count: String(count), name }
  if (brief.includes('{input}')) {
    return brief.replace(/\{(input|index|count|name)\}/g, (_, key) => vars[key])
  }
  const rendered = brief.replace(/\{(index|count|name)\}/g, (_, key) => vars[key])
  return rendered + '\n\n---\nShard ' + vars.index + ' of ' + vars.count + '\nInput: ' + vars.input
}

export function isBatch(store, prefix) {
  if (typeof prefix !== 'string' || !prefix.trim() || !store?.hasTable?.('batches')) return false
  return Boolean(store.stmt('SELECT 1 FROM batches WHERE prefix=?').get(prefix.trim()))
}

function classifyShardStatus(convStatus, ticket) {
  if (!convStatus) return 'queued'
  if (ticket?.status === 'done') return 'done'
  if (convStatus === 'error' || ticket?.flag === 'error') return 'error'
  if (convStatus === 'stopped' || ticket?.flag === 'stopped') return 'stopped'
  if (convStatus === 'running') return 'working'
  if (convStatus === 'queued') return 'queued'
  return 'review'
}

function previewReply(text) {
  if (typeof text !== 'string' || !text.trim()) return null
  const compact = text.trim().replace(/\s+/g, ' ')
  return compact.length > 200 ? compact.slice(0, 197) + '...' : compact
}

function parseStatusFilter(status) {
  if (!status) return null
  const list = Array.isArray(status)
    ? status
    : String(status).split(',').map(s => s.trim()).filter(Boolean)
  return list.length ? new Set(list) : null
}

export function batchDetail(store, prefix, { full = false, status = null } = {}) {
  if (!isBatch(store, prefix)) return null
  const row = store.stmt('SELECT * FROM batches WHERE prefix=?').get(prefix.trim())
  const items = JSON.parse(row.shards)
  const counts = { queued: 0, working: 0, review: 0, done: 0, error: 0, stopped: 0 }

  const namesJson = JSON.stringify(items.map(i => i.name))
  const convByName = new Map()
  for (const c of store.stmt('SELECT id,name,status,turn,activity FROM conversations WHERE name IN (SELECT value FROM json_each(?))').all(namesJson)) {
    convByName.set(c.name, c)
  }
  const ticketByName = new Map()
  for (const t of store.ticketRows('WHERE c.name IN (SELECT value FROM json_each(?))', namesJson)) {
    ticketByName.set(t.id, t)
  }
  const replyByName = new Map()
  for (const r of store.stmt("SELECT c.name,m.content FROM messages m JOIN conversations c ON c.id=m.cid AND c.turn=m.turn WHERE m.kind='reply' AND c.name IN (SELECT value FROM json_each(?)) ORDER BY m.id ASC").all(namesJson)) {
    replyByName.set(r.name, r.content)
  }

  const allShards = items.map(item => {
    const c = convByName.get(item.name)
    const ticket = ticketByName.get(item.name) ?? null
    const shardStatus = classifyShardStatus(c?.status, ticket)
    counts[shardStatus] += 1
    const fullReply = replyByName.get(item.name) ?? null
    const entry = {
      name: item.name,
      index: item.index,
      turn: c?.turn ?? 0,
      input: item.input,
      status: shardStatus,
      stage: ticket?.status ?? 'queued',
      flag: ticket?.flag ?? null,
      outcome: ticket?.outcome ?? null,
      problem: ticket?.problem ?? null,
      activity: ticket?.activity ?? c?.activity ?? 'Queued',
      currentStep: ticket?.currentStep ?? null,
      lastHeartbeatAt: ticket?.lastHeartbeatAt ?? null,
      queue: ticket?.queue ?? null,
      replyPreview: previewReply(fullReply),
      elapsedMs: ticket?.elapsedMs ?? 0
    }
    if (full) {
      entry.reply = fullReply
      entry.changedFiles = ticket?.changedFiles ?? null
      entry.worktree = ticket?.worktree ?? null
    }
    return entry
  })

  const filterSet = parseStatusFilter(status)
  const shards = filterSet ? allShards.filter(s => filterSet.has(s.status)) : allShards

  return {
    isBatch: true,
    prefix: row.prefix,
    title: row.title,
    brief: row.brief,
    worker: row.worker,
    model: row.model,
    effort: row.effort,
    cwd: row.cwd,
    createdAt: new Date(row.created).toISOString(),
    createdLocal: formatDateTime(row.created),
    count: allShards.length,
    counts,
    finished: counts.queued + counts.working === 0,
    shards
  }
}

export function listBatches(store) {
  if (!store?.hasTable?.('batches')) return []
  return store.stmt('SELECT prefix FROM batches ORDER BY created ASC, prefix ASC').all().map(r => batchDetail(store, r.prefix)).filter(Boolean)
}

export async function dispatchMap(crew, { prefix, brief, inputs, worker, model, effort, cwd, defaultCwd, worktree, title, env } = {}) {
  if (typeof prefix !== 'string' || !prefix.trim() || /[\x00-\x1f\x7f\s]/.test(prefix.trim())) {
    throw new Error('Invalid batch prefix')
  }
  prefix = prefix.trim()
  if (typeof brief !== 'string' || !brief.trim()) throw new Error('Batch brief is empty')
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 200) {
    throw new Error('Expected 1..200 batch inputs')
  }
  const normalizedInputs = inputs.map(item => {
    const value = typeof item === 'number' ? String(item) : item
    if (typeof value !== 'string' || !value.trim()) throw new Error('Batch inputs must be non-empty strings')
    return value
  })
  const store = crew.store
  if (isBatch(store, prefix)) throw new Error('Batch already exists: ' + prefix)
  if (store.byName(prefix)) throw new Error('Conversation already exists: ' + prefix)
  const count = normalizedInputs.length
  const planned = normalizedInputs.map((input, idx) => {
    const index = idx + 1
    const name = prefix + '-' + index
    if (store.byName(name)) throw new Error('Conversation already exists: ' + name)
    return {
      index,
      name,
      input,
      prompt: formatShardPrompt(brief, { input, index, count, name })
    }
  })
  const batchTitle = typeof title === 'string' && title.trim() ? title.trim() : prefix
  store.stmt('INSERT INTO batches(prefix,title,brief,worker,model,effort,cwd,created,shards) VALUES (?,?,?,?,?,?,?,?,?)').run(
    prefix,
    batchTitle,
    brief,
    worker ?? null,
    model ?? null,
    effort ?? null,
    cwd ?? null,
    Date.now(),
    JSON.stringify(planned.map(({ name, index, input }) => ({ name, index, input })))
  )
  const shards = []
  const warnings = []
  const seenWarnings = new Set()
  const prevSuppress = Boolean(crew.slots?.suppressNotify)
  if (crew.slots) crew.slots.suppressNotify = true
  try {
    for (const shard of planned) {
      let receipt = await crew.serial(shard.name, () => crew.say({
        name: shard.name,
        text: shard.prompt,
        title: batchTitle + ' [' + shard.index + '/' + count + ']',
        worker,
        model,
        effort,
        cwd,
        defaultCwd,
        worktree,
        env
      }))
      if (receipt.delivery) receipt = await receipt.delivery
      for (const w of receipt.warnings ?? []) {
        const key = w.code ?? w.message
        if (!seenWarnings.has(key)) {
          seenWarnings.add(key)
          warnings.push(w)
        }
      }
      shards.push({
        name: shard.name,
        index: shard.index,
        input: shard.input,
        turn: receipt.turn,
        status: receipt.kind === 'queued' ? 'queued' : 'working',
        worker: receipt.worker,
        model: receipt.model,
        effort: receipt.effort,
        cwd: receipt.cwd,
        queue: receipt.queue ?? null
      })
    }
    if (shards[0]) {
      store.stmt('UPDATE batches SET worker=coalesce(worker,?),model=coalesce(model,?),effort=coalesce(effort,?),cwd=coalesce(cwd,?) WHERE prefix=?').run(
        shards[0].worker ?? null,
        shards[0].model ?? null,
        shards[0].effort ?? null,
        shards[0].cwd ?? null,
        prefix
      )
    }
  } catch (err) {
    const createdItems = planned
      .filter(s => store.byName(s.name))
      .map(({ name, index, input }) => ({ name, index, input }))
    if (!createdItems.length) {
      store.stmt('DELETE FROM batches WHERE prefix=?').run(prefix)
    } else {
      store.stmt('UPDATE batches SET shards=? WHERE prefix=?').run(JSON.stringify(createdItems), prefix)
    }
    throw err
  } finally {
    if (crew.slots && !prevSuppress) crew.slots.flushNotifications?.()
  }
  return { prefix, title: batchTitle, count: shards.length, ...(warnings.length ? { warnings } : {}), shards }
}

export function doneBatch(store, prefix, { result, why } = {}) {
  if (!isBatch(store, prefix)) throw new Error('Unknown batch: ' + prefix)
  if (result !== undefined && !outcomes.includes(result)) throw new Error('Expected --result ' + outcomes.join('|'))
  if (why !== undefined && (typeof why !== 'string' || why.length > 2000)) throw new Error('Invalid --why')
  const row = store.stmt('SELECT shards FROM batches WHERE prefix=?').get(prefix.trim())
  const items = JSON.parse(row.shards)
  const closed = []
  const skipped = []
  for (const item of items) {
    const c = store.byName(item.name)
    if (!c) {
      skipped.push({ name: item.name, status: 'missing', reason: 'Conversation not found' })
      continue
    }
    const ticket = store.ticket(c.id)
    const status = classifyShardStatus(c.status, ticket)
    if (ticket.status === 'done') {
      skipped.push({ name: item.name, status: 'done', outcome: ticket.outcome, reason: 'Already closed' })
      continue
    }
    const canClose = ticket.status === 'review' || (['fail', 'blocked'].includes(result) && ['error', 'stopped'].includes(c.status))
    if (!canClose) {
      const reason = ['queued', 'working'].includes(status)
        ? 'Shard is still ' + status
        : 'Pass --result fail or blocked to close a ' + status + ' shard'
      skipped.push({ name: item.name, status, reason })
      continue
    }
    const updated = store.done(item.name, { result, why })
    closed.push({
      name: item.name,
      outcome: updated.outcome,
      task: updated.task,
      startTurn: updated.startTurn,
      endTurn: updated.endTurn
    })
  }
  return { prefix: prefix.trim(), closed, skipped }
}

export async function stopBatch(crew, prefix) {
  const store = crew.store
  if (!isBatch(store, prefix)) throw new Error('Unknown batch: ' + prefix)
  const row = store.stmt('SELECT shards FROM batches WHERE prefix=?').get(prefix.trim())
  const items = JSON.parse(row.shards)
  const queued = []
  const running = []
  const skipped = []
  for (const item of items) {
    const c = store.byName(item.name)
    if (!c) {
      skipped.push({ name: item.name, status: 'missing' })
    } else if (c.status === 'queued') {
      queued.push(item.name)
    } else if (c.status === 'running') {
      running.push(item.name)
    } else {
      skipped.push({ name: item.name, status: c.status })
    }
  }
  const stopped = []
  const prevSuppress = Boolean(crew.slots?.suppressNotify)
  if (crew.slots) crew.slots.suppressNotify = true
  try {
    for (const name of queued) {
      const res = await crew.serial(name, () => crew.stop(name))
      stopped.push(res)
    }
    if (running.length) {
      const runningResults = await Promise.all(running.map(name => crew.serial(name, () => crew.stop(name))))
      stopped.push(...runningResults)
    }
  } finally {
    if (crew.slots && !prevSuppress) crew.slots.flushNotifications?.()
  }
  return { prefix: prefix.trim(), stopped, skipped }
}

export async function retryBatch(crew, prefix, { model, effort, worker, env } = {}) {
  const store = crew.store
  if (!isBatch(store, prefix)) throw new Error('Unknown batch: ' + prefix)
  const row = store.stmt('SELECT * FROM batches WHERE prefix=?').get(prefix.trim())
  const items = JSON.parse(row.shards)
  const retried = []
  const skipped = []
  const prevSuppress = Boolean(crew.slots?.suppressNotify)
  if (crew.slots) crew.slots.suppressNotify = true
  try {
    for (const item of items) {
      const c = store.byName(item.name)
      if (!c) {
        skipped.push({ name: item.name, index: item.index, input: item.input, status: 'missing', reason: 'Conversation not found' })
        continue
      }
      const ticketRow = store.stmt('SELECT stage,flag FROM tickets WHERE cid=?').get(c.id)
      const lastTurn = store.stmt('SELECT status FROM turns WHERE cid=? AND turn=?').get(c.id, c.turn)
      const shardStatus = classifyShardStatus(c.status, { status: ticketRow?.stage, flag: ticketRow?.flag })
      if (!['error', 'stopped'].includes(shardStatus) || !['error', 'stopped'].includes(lastTurn?.status)) {
        skipped.push({ name: item.name, index: item.index, input: item.input, status: shardStatus, reason: 'Shard is ' + shardStatus })
        continue
      }
      let receipt = await crew.serial(item.name, () => crew.retry(item.name, { model, effort, worker, env }))
      if (receipt.delivery) receipt = await receipt.delivery
      retried.push({
        name: item.name,
        index: item.index,
        input: item.input,
        turn: receipt.turn,
        retriedTurn: receipt.retriedTurn,
        status: receipt.kind === 'queued' ? 'queued' : 'working',
        worker: receipt.worker,
        model: receipt.model,
        effort: receipt.effort,
        queue: receipt.queue ?? null
      })
    }
  } finally {
    if (crew.slots && !prevSuppress) crew.slots.flushNotifications?.()
  }
  return { isBatch: true, prefix: row.prefix, retried, skipped }
}
