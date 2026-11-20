import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Slots } from '../lib/slots.mjs'
import { Store } from '../lib/store.mjs'
import { Crew, normalizeAgyModel } from '../lib/crew.mjs'
import { batchDetail, dispatchMap, doneBatch, formatShardPrompt, isBatch, listBatches, stopBatch } from '../lib/map.mjs'
import { harness, until } from './harness.mjs'

const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ioAAAAASUVORK5CYII=', 'base64')

function makeEnv(t, defaultLimit = 2) {
  const root = mkdtempSync(join(tmpdir(), 'cc-bro-qm-'))
  const slots = new Slots(defaultLimit)
  const stores = []
  t.after(() => {
    for (const s of stores) s.db.close()
    rmSync(root, { recursive: true, force: true })
  })
  function makeProject(id, extraSettings = {}) {
    const dir = join(root, id)
    mkdirSync(dir, { recursive: true })
    const dbPath = join(dir, 'tickets.sqlite')
    const store = new Store(false, dbPath)
    stores.push(store)
    const settings = { id, repoPath: dir, allow: ['codex', 'agy', 'pi:deepseek'], worker: 'codex', entries: {}, rules: [], ...extraSettings }
    const gates = new Map()
    const startedOrder = []
    const crew = new Crew(store, slots, () => settings)
    crew.runNative = async (c, text, controller, ready) => {
      startedOrder.push(c.name)
      ready.resolve(null)
      store.stmt('UPDATE conversations SET native_id=?,transport=? WHERE id=?').run('sess-' + c.name, 'app-server', c.id)
      const gate = Promise.withResolvers()
      gates.set(c.name, {
        finish(reply = 'reply:' + text) {
          gate.resolve({ status: 'done', reply })
        },
        fail(msg = 'boom') {
          gate.resolve({ status: 'error', error: msg })
        }
      })
      controller.signal.addEventListener('abort', () => gate.resolve({ status: 'stopped' }), { once: true })
      const outcome = await gate.promise
      gates.delete(c.name)
      if (outcome.status === 'stopped' || controller.signal.aborted) {
        store.finish(c.id, c.turn, 'stopped', 'Stopped by manager')
      } else if (outcome.status === 'error') {
        store.finish(c.id, c.turn, 'error', outcome.error)
      } else {
        store.finish(c.id, c.turn, 'done', 'Waiting for manager', store.assistant(c.id, c.turn, outcome.reply))
      }
    }
    return { id, dir, dbPath, store, settings, crew, gates, startedOrder }
  }
  return { root, slots, makeProject }
}

test('per-project pools isolate concurrency, preserve strict FIFO, and dynamically scale via setLimit', async t => {
  const { slots, makeProject } = makeEnv(t, 2)
  const projA = makeProject('projA')
  const projB = makeProject('projB')

  const r1 = await projA.crew.say({ name: 'alpha-1', text: 'one', defaultCwd: projA.dir })
  const r2 = await projA.crew.say({ name: 'alpha-2', text: 'two', defaultCwd: projA.dir })
  const r3 = await projA.crew.say({ name: 'alpha-3', text: 'three', defaultCwd: projA.dir })
  const r4 = await projA.crew.say({ name: 'alpha-4', text: 'four', defaultCwd: projA.dir })

  assert.equal(r1.queue, null)
  assert.equal(r2.queue, null)
  assert.deepEqual(r3.queue, { position: 1, totalQueued: 1, limit: 2, activeNames: ['alpha-1', 'alpha-2'] })
  assert.deepEqual(r4.queue, { position: 2, totalQueued: 2, limit: 2, activeNames: ['alpha-1', 'alpha-2'] })

  const c3 = projA.store.byName('alpha-3')
  assert.deepEqual(slots.queueInfo(c3.id), {
    position: 1,
    totalQueued: 2,
    limit: 2,
    scope: 'projA',
    activeNames: ['alpha-1', 'alpha-2']
  })

  const rows = projA.store.ticketRows()
  const row3 = rows.find(r => r.id === 'alpha-3')
  const row4 = rows.find(r => r.id === 'alpha-4')
  assert.equal(row3.activity, 'Queued (#1 of 2, limit 2; active: alpha-1, alpha-2)')
  assert.equal(row4.activity, 'Queued (#2 of 2, limit 2; active: alpha-1, alpha-2)')

  const readOnly = new Store(true, projA.dbPath)
  try {
    const ro3 = readOnly.ticketRows().find(r => r.id === 'alpha-3')
    assert.deepEqual(ro3.queue, { position: 1, totalQueued: 2, limit: 2, activeNames: ['alpha-1', 'alpha-2'] })
    assert.equal(ro3.activity, 'Queued (#1 of 2, limit 2; active: alpha-1, alpha-2)')
    assert.deepEqual(readOnly.result(c3.id, 1).queue, ro3.queue)
  } finally {
    readOnly.db.close()
  }

  const b1 = await projB.crew.say({ name: 'beta-1', text: 'alpha', defaultCwd: projB.dir })
  const b2 = await projB.crew.say({ name: 'beta-2', text: 'beta', defaultCwd: projB.dir })
  assert.equal(b1.queue, null)
  assert.equal(b2.queue, null)
  assert.deepEqual(projB.startedOrder, ['beta-1', 'beta-2'])
  assert.deepEqual(projA.startedOrder, ['alpha-1', 'alpha-2'])

  projA.gates.get('alpha-1').finish('done-1')
  await until(() => projA.startedOrder.includes('alpha-3'))
  assert.deepEqual(projA.startedOrder, ['alpha-1', 'alpha-2', 'alpha-3'])
  assert.equal(projA.store.ticketRows().find(r => r.id === 'alpha-4').activity, 'Queued (#1 of 1, limit 2; active: alpha-2, alpha-3)')

  const r5 = await projA.crew.say({ name: 'alpha-5', text: 'five', defaultCwd: projA.dir })
  assert.equal(r5.queue.position, 2)

  slots.setLimit('projA', 4)
  await until(() => projA.startedOrder.length === 5)
  assert.deepEqual(projA.startedOrder, ['alpha-1', 'alpha-2', 'alpha-3', 'alpha-4', 'alpha-5'])
  assert.equal(slots.queueInfo(c3.id), null)

  slots.setLimit('projA', null)
  assert.equal(slots.limitFor('projA', projA.crew), 2)
  slots.setLimit('global', 3)
  assert.equal(slots.limit, 3)
  for (const bad of [0, -2, 1.5, '3']) assert.throws(() => slots.setLimit('projA', bad), /positive integer/)

  for (const g of [...projA.gates.values(), ...projB.gates.values()]) g.finish()
})

test('CLI runner isolates queues across two registered projects and surfaces rich queue details in ls and show', async t => {
  const h = harness(t, false, { BROCO_CONCURRENCY: '1' })
  const projB = join(h.base, 'project-b')
  mkdirSync(projB)
  await h.json('init', '--allow', 'codex')
  await h.at(projB, 'init', '--allow', 'codex')

  await h.json('say', 'hold-a', 'hold', '--bg')
  const qA = await h.json('say', 'wait-a', 'hello-a', '--bg')
  assert.equal(qA.kind, 'queued')
  assert.deepEqual(qA.queue, { position: 1, totalQueued: 1, limit: 1, activeNames: ['hold-a'] })

  const lsA = await h.json('ls')
  const waitRow = lsA.find(r => r.id === 'wait-a')
  assert.equal(waitRow.activity, 'Queued (#1 of 1, limit 1; active: hold-a)')
  assert.deepEqual(waitRow.queue, { position: 1, totalQueued: 1, limit: 1, activeNames: ['hold-a'] })
  assert.match(await h.cli('ls'), /Queued \(#1 of 1, limit 1; active: hold-a\)/)

  const shownWait = await h.json('show', 'wait-a')
  assert.deepEqual(shownWait.queue, { position: 1, totalQueued: 1, limit: 1, activeNames: ['hold-a'] })
  assert.deepEqual(shownWait.progress.queue, { position: 1, totalQueued: 1, limit: 1, activeNames: ['hold-a'] })

  const bDone = JSON.parse(await h.at(projB, 'say', 'fast-b', 'unblocked', '--json'))
  assert.equal(bDone.reply, 'unblocked')

  await h.cli('stop', 'hold-a')
  assert.equal((await h.json('wait', 'wait-a', '1')).reply, 'hello-a')
})

test('slot release never leaks on stop, startTurn pre-finish throw, or stale finish with zero changes', async t => {
  const { slots, makeProject } = makeEnv(t, 1)
  const proj = makeProject('leak-check')

  await proj.crew.say({ name: 'one', text: 'first', defaultCwd: proj.dir })
  await proj.crew.say({ name: 'two', text: 'second', defaultCwd: proj.dir })
  await proj.crew.stop('two')
  assert.equal(slots.pools.get('leak-check').queue.size, 0)

  await proj.crew.say({ name: 'three', text: 'third', defaultCwd: proj.dir })
  assert.equal(slots.pools.get('leak-check').queue.size, 1)
  await proj.crew.stop('one')
  await until(() => proj.startedOrder.includes('three'))
  assert.equal(slots.pools.get('leak-check').active.size, 1)

  const missingDir = join(proj.dir, 'vanished')
  mkdirSync(missingDir)
  await proj.crew.say({ name: 'vanish', text: 'fail-before-run', cwd: missingDir, defaultCwd: proj.dir })
  await proj.crew.say({ name: 'four', text: 'fourth', defaultCwd: proj.dir })
  rmSync(missingDir, { recursive: true, force: true })
  proj.gates.get('three').finish('ok-3')
  await until(() => proj.startedOrder.includes('four'))
  assert.equal(proj.store.byName('vanish').status, 'error')
  assert.equal(slots.pools.get('leak-check').active.size, 1)

  const four = proj.store.byName('four')
  proj.store.stmt("UPDATE turns SET status='error' WHERE cid=? AND turn=?").run(four.id, four.turn)
  proj.store.finish(four.id, four.turn, 'error', 'already-updated')
  assert.equal(slots.pools.get('leak-check').active.size, 0)
  proj.gates.get('four')?.finish()
})

test('unbound session warning, crew.retry with model/effort/worker fixup and attachments, and agy model normalization', async t => {
  const { makeProject } = makeEnv(t, 2)
  const proj = makeProject('retry-guard')

  assert.equal(normalizeAgyModel('gemini-4-argon', 'high'), 'gemini-4-argon-high')
  assert.equal(normalizeAgyModel('gemini-4-argon-medium', 'high'), 'gemini-4-argon-high')
  assert.equal(normalizeAgyModel('gemini-4-argon', null), 'gemini-4-argon-medium')
  assert.equal(normalizeAgyModel('gemini-3.8-flash-high', 'low'), 'gemini-3.8-flash-low')
  assert.equal(normalizeAgyModel('fixture-model', 'low', ['fixture-model']), 'fixture-model')
  assert.equal(normalizeAgyModel('claude-sonnet-4-6', 'high'), 'claude-sonnet-4-6')

  const agyReceipt = await proj.crew.say({
    name: 'agy-norm',
    text: 'check',
    worker: 'agy',
    model: 'gemini-4-argon-medium',
    effort: 'high',
    defaultCwd: proj.dir
  })
  assert.equal(agyReceipt.model, 'gemini-4-argon-high')
  assert.equal(proj.store.byName('agy-norm').model, 'gemini-4-argon-high')
  const agyExec = JSON.parse(proj.store.stmt('SELECT execution FROM turns WHERE cid=? AND turn=1').get(proj.store.byName('agy-norm').id).execution)
  assert.equal(agyExec.contextTokens, 1048576)
  proj.gates.get('agy-norm').finish('ok')

  const unbound = proj.store.create('unbound', proj.dir, 'gemini-4-argon-medium', 'Unbound', 'medium', 'agy')
  proj.store.stmt('INSERT INTO collaboration(cid) VALUES (?)').run(unbound.id)
  proj.store.accept(unbound, 'Original full specification prompt')
  proj.store.finish(unbound.id, 1, 'error', 'Invalid model combination')

  const followReceipt = await proj.crew.say({
    name: 'unbound',
    text: 'short follow-up without full prompt',
    worker: 'agy',
    model: 'gemini-4-argon',
    effort: 'high',
    defaultCwd: proj.dir
  })
  assert.equal(followReceipt.previousSessionBound, false)
  assert.match(followReceipt.sessionWarning, /上一轮未建立原生会话/)
  assert.ok(followReceipt.reminders.some(r => r.includes('上一轮未建立原生会话')))
  proj.gates.get('unbound').finish('done')

  const imgPath = join(proj.dir, 'diagram.png')
  writeFileSync(imgPath, TINY_PNG)
  let capturedPrompt = null
  let capturedAttachments = null
  let failFirst = true
  const origRun = proj.crew.runNative.bind(proj.crew)
  proj.crew.runNative = async (c, text, controller, ready, meta) => {
    capturedPrompt = text
    capturedAttachments = c.attachments
    if (failFirst && c.name === 'with-img') {
      failFirst = false
      ready.resolve(null)
      proj.store.finish(c.id, c.turn, 'error', 'Temporary network error before session bind')
      return
    }
    return origRun(c, text, controller, ready, meta)
  }

  await proj.crew.say({
    name: 'with-img',
    text: 'Inspect this diagram carefully',
    attachments: [imgPath],
    worker: 'codex',
    model: 'gpt-6-astra',
    effort: 'medium',
    defaultCwd: proj.dir
  })
  await until(() => proj.store.byName('with-img').status === 'error')
  rmSync(imgPath)

  const retried = await proj.crew.retry('with-img', { model: 'gpt-6.1-sol', effort: 'high' })
  assert.equal(retried.retriedTurn, 1)
  assert.equal(retried.turn, 2)
  assert.equal(retried.model, 'gpt-6.1-sol')
  assert.equal(retried.effort, 'high')
  assert.equal(retried.sessionWarning, undefined)
  assert.equal(capturedPrompt, 'Inspect this diagram carefully')
  assert.equal(capturedAttachments.length, 1)
  proj.gates.get('with-img').finish('diagram-inspected')
  await until(() => proj.store.byName('with-img').status === 'idle')

  await assert.rejects(proj.crew.retry('with-img'), /failed or stopped/)

  const gitDir = join(proj.dir, 'git-repo')
  mkdirSync(gitDir)
  execFileSync('git', ['init', '-q'], { cwd: gitDir })
  writeFileSync(join(gitDir, 'README.md'), 'seed\n')
  execFileSync('git', ['add', 'README.md'], { cwd: gitDir })
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@localhost', 'commit', '-qm', 'init'], { cwd: gitDir })
  proj.settings.repoPath = gitDir

  await proj.crew.say({ name: 'wt-job', text: 'build feature in worktree', worktree: true, defaultCwd: gitDir })
  await proj.crew.stop('wt-job')
  const wtRetried = await proj.crew.retry('wt-job', { effort: 'low' })
  assert.equal(wtRetried.turn, 2)
  proj.gates.get('wt-job').finish('wt-ok')
})

test('detail collapses consecutive heartbeat events with configured BROCO_TZ time and builds rich progress', t => {
  const prevTz = process.env.BROCO_TZ
  process.env.BROCO_TZ = 'Asia/Shanghai'
  const dir = mkdtempSync(join(tmpdir(), 'broco-detail-'))
  const store = new Store(false, join(dir, 'tickets.sqlite'))
  t.after(() => {
    if (prevTz === undefined) delete process.env.BROCO_TZ
    else process.env.BROCO_TZ = prevTz
    store.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const c = store.create('noisy', dir, 'gemini-4-argon-high', 'Noisy run', 'high', 'agy')
  store.stmt('INSERT INTO collaboration(cid,files) VALUES (?,?)').run(c.id, JSON.stringify([{ path: 'a.mjs', status: 'M' }, { path: 'b.mjs', status: 'A' }]))
  store.accept(c, 'run')
  store.claim(store.byName('noisy'))
  store.working(store.byName('noisy'))

  store.event(c.id, 1, 'tool.started', { step: 1 }, 'read_file ACTIVE')
  store.event(c.id, 1, 'tool.completed', { step: 1 }, 'read_file DONE')
  const baseTs = Date.UTC(2026, 10, 17, 17, 0, 0)
  const insertEvent = store.stmt('INSERT INTO events(cid,turn,at,kind,raw,summary) VALUES (?,?,?,?,?,?)')
  store.transaction(() => {
    for (let i = 0; i < 488; i++) {
      insertEvent.run(c.id, 1, baseTs + i * 1000, 'tool.started', '{}', 'agent_response ACTIVE')
    }
  })

  const detail = store.detail('noisy')
  const collapsed = detail.timeline.find(e => e.summary.startsWith('agent_response ACTIVE'))
  assert.equal(collapsed.count, 488)
  assert.equal(collapsed.ts, new Date(baseTs).toISOString())
  assert.equal(collapsed.lastTs, new Date(baseTs + 487 * 1000).toISOString())
  assert.match(collapsed.summary, /agent_response ACTIVE \(×488, last 2026-11-18 01:08:07\)/)

  assert.equal(detail.progress.status, 'running')
  assert.equal(detail.progress.currentStep, 'read_file DONE')
  assert.equal(detail.progress.changedFilesCount, 2)
  assert.ok(detail.progress.eventCount >= 492)
  assert.equal(detail.progress.lastHeartbeatAt, new Date(baseTs + 487 * 1000).toISOString())
})

test('cc-bro map dispatches shards FIFO, formats prompts safely, tracks batchDetail, and closes shards via doneBatch', async t => {
  const { makeProject } = makeEnv(t, 2)
  const proj = makeProject('map-proj')

  assert.equal(
    formatShardPrompt('Audit {input} ({index}/{count}) as {name}', { input: 'src/$&/a.mjs', index: 2, count: 5, name: 'audit-2' }),
    'Audit src/$&/a.mjs (2/5) as audit-2'
  )
  assert.equal(
    formatShardPrompt('Check module exports', { input: 'lib/slots.mjs', index: 1, count: 3, name: 'm-1' }),
    'Check module exports\n\n---\nShard 1 of 3\nInput: lib/slots.mjs'
  )

  await assert.rejects(dispatchMap(proj.crew, { prefix: '', brief: 'x', inputs: ['a'] }), /Invalid batch prefix/)
  await assert.rejects(dispatchMap(proj.crew, { prefix: 'b', brief: ' ', inputs: ['a'] }), /brief is empty/)
  await assert.rejects(dispatchMap(proj.crew, { prefix: 'b', brief: 'x', inputs: [] }), /1\.\.200/)
  await assert.rejects(dispatchMap(proj.crew, { prefix: 'b', brief: 'x', inputs: Array(201).fill('x') }), /1\.\.200/)
  await assert.rejects(dispatchMap(proj.crew, { prefix: 'bad-w', brief: 'x', inputs: ['a'], worker: 'cursor-agent', defaultCwd: proj.dir }), /not allowed/)
  assert.equal(isBatch(proj.store, 'bad-w'), false)

  const dispatched = await dispatchMap(proj.crew, {
    prefix: 'mod',
    title: 'Module sweep',
    brief: 'Inspect {input} in shard {index}/{count}',
    inputs: ['a.mjs', 'b.mjs', 'c.mjs', 'd.mjs', 'e.mjs'],
    defaultCwd: proj.dir
  })
  assert.equal(dispatched.count, 5)
  assert.equal(isBatch(proj.store, 'mod'), true)
  assert.equal(listBatches(proj.store).length, 1)

  await assert.rejects(dispatchMap(proj.crew, { prefix: 'mod', brief: 'x', inputs: ['z.mjs'], defaultCwd: proj.dir }), /Batch already exists/)

  let detail = batchDetail(proj.store, 'mod')
  assert.equal(detail.isBatch, true)
  assert.equal(detail.finished, false)
  assert.deepEqual(detail.counts, { queued: 3, working: 2, review: 0, done: 0, error: 0, stopped: 0 })
  assert.equal(detail.shards[2].queue.position, 1)

  proj.gates.get('mod-1').finish('Clean: a.mjs')
  proj.gates.get('mod-2').finish('Clean: b.mjs')
  await until(() => proj.startedOrder.includes('mod-3') && proj.startedOrder.includes('mod-4'))
  proj.gates.get('mod-3').finish('Clean: c.mjs')
  await until(() => proj.startedOrder.includes('mod-5'))
  proj.gates.get('mod-4').fail('429 Too Many Requests: quota exhausted')
  proj.gates.get('mod-5').finish('Clean: e.mjs')
  await until(() => batchDetail(proj.store, 'mod').finished)

  detail = batchDetail(proj.store, 'mod')
  assert.equal(detail.finished, true)
  assert.deepEqual(detail.counts, { queued: 0, working: 0, review: 4, done: 0, error: 1, stopped: 0 })
  assert.equal(detail.shards[0].replyPreview, 'Clean: a.mjs')
  assert.equal(detail.shards[3].problem.class, 'quota')

  const firstClose = doneBatch(proj.store, 'mod', { why: 'Verified clean shards' })
  assert.equal(firstClose.closed.length, 4)
  assert.equal(firstClose.skipped.length, 1)
  assert.equal(firstClose.skipped[0].name, 'mod-4')

  const secondClose = doneBatch(proj.store, 'mod', { result: 'blocked', why: 'Quota hit on shard 4' })
  assert.deepEqual(secondClose.closed.map(s => [s.name, s.outcome]), [['mod-4', 'blocked']])
  assert.equal(secondClose.skipped.length, 4)
  assert.deepEqual(batchDetail(proj.store, 'mod').counts, { queued: 0, working: 0, review: 0, done: 5, error: 0, stopped: 0 })

  await dispatchMap(proj.crew, {
    prefix: 'halt',
    brief: 'Hold shard',
    inputs: ['1', '2', '3'],
    defaultCwd: proj.dir
  })
  const stopped = await stopBatch(proj.crew, 'halt')
  assert.equal(stopped.stopped.length, 3)
  assert.deepEqual(batchDetail(proj.store, 'halt').counts, { queued: 0, working: 0, review: 0, done: 0, error: 0, stopped: 3 })
})
