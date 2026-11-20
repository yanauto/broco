import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import test from 'node:test'
import { promisify } from 'node:util'
import { describeAttachments, gcAttachments, snapshotAttachments } from '../lib/attachments.mjs'
import { CredentialProxies, proxyConfig } from '../lib/credential-proxy.mjs'
import { Crew } from '../lib/crew.mjs'
import { batchDetail, dispatchMap, doneBatch, retryBatch, stopBatch } from '../lib/map.mjs'
import { repo, socketFor } from '../lib/paths.mjs'
import { parseRedactedJson, redactStderr, secretsFrom } from '../lib/pi-secrets.mjs'
import { classify } from '../lib/problems.mjs'
import { Slots } from '../lib/slots.mjs'
import { ticketRecords } from '../lib/stats.mjs'
import { Store } from '../lib/store.mjs'
import { agyModel, clearAgyUsageCache, resetEpoch, streamTurn } from '../lib/stream-workers.mjs'
import { baseline, changes, changesAsync, cleanWorktrees, createTree, diffWorktree } from '../lib/worktree.mjs'
import { alive, harness, until, writeFakeCli } from './harness.mjs'

const exec = promisify(execFile)
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ioAAAAASUVORK5CYII=', 'base64')

function findJsComments(source) {
  const found = []
  const len = source.length
  let i = 0
  let line = 1
  let canBeRegex = true
  const templateBraceStack = []

  const advance = ch => { if (ch === '\n') line++ }

  while (i < len) {
    const ch = source[i]
    const next = source[i + 1]

    if (i === 0 && ch === '#' && next === '!') {
      while (i < len && source[i] !== '\n') i++
      continue
    }

    if (/\s/.test(ch)) {
      advance(ch)
      i++
      continue
    }

    if (ch === "'" || ch === '"') {
      const quote = ch
      i++
      while (i < len && source[i] !== quote) {
        if (source[i] === '\\') {
          advance(source[i])
          i++
          if (i < len) advance(source[i])
        } else {
          advance(source[i])
        }
        i++
      }
      i++
      canBeRegex = false
      continue
    }

    if (ch === '`') {
      i++
      while (i < len && source[i] !== '`') {
        if (source[i] === '\\') {
          advance(source[i])
          i += 2
          continue
        }
        if (source[i] === '$' && source[i + 1] === '{') {
          templateBraceStack.push(0)
          i += 2
          canBeRegex = true
          break
        }
        advance(source[i])
        i++
      }
      if (source[i] === '`') {
        i++
        canBeRegex = false
      }
      continue
    }

    if (ch === '{' && templateBraceStack.length > 0) {
      templateBraceStack[templateBraceStack.length - 1]++
      i++
      canBeRegex = true
      continue
    }

    if (ch === '}' && templateBraceStack.length > 0) {
      if (templateBraceStack[templateBraceStack.length - 1] === 0) {
        templateBraceStack.pop()
        i++
        while (i < len && source[i] !== '`') {
          if (source[i] === '\\') {
            advance(source[i])
            i += 2
            continue
          }
          if (source[i] === '$' && source[i + 1] === '{') {
            templateBraceStack.push(0)
            i += 2
            canBeRegex = true
            break
          }
          advance(source[i])
          i++
        }
        if (source[i] === '`') {
          i++
          canBeRegex = false
        }
        continue
      }
      templateBraceStack[templateBraceStack.length - 1]--
      i++
      canBeRegex = false
      continue
    }

    if (ch === '/' && next === '/') {
      found.push({ line, kind: 'line' })
      while (i < len && source[i] !== '\n') i++
      continue
    }

    if (ch === '/' && next === '*') {
      found.push({ line, kind: 'block' })
      i += 2
      while (i < len && !(source[i] === '*' && source[i + 1] === '/')) {
        advance(source[i])
        i++
      }
      i += 2
      continue
    }

    if (ch === '/' && canBeRegex) {
      i++
      let inClass = false
      while (i < len) {
        const c = source[i]
        if (c === '\\') {
          advance(c)
          i += 2
          continue
        }
        if (c === '[') inClass = true
        else if (c === ']') inClass = false
        else if (c === '/' && !inClass) {
          i++
          while (i < len && /[a-z]/i.test(source[i])) i++
          break
        }
        advance(c)
        i++
      }
      canBeRegex = false
      continue
    }

    if (/[A-Za-z0-9_$]/.test(ch)) {
      let word = ''
      while (i < len && /[A-Za-z0-9_$]/.test(source[i])) {
        word += source[i]
        i++
      }
      canBeRegex = ['return', 'throw', 'case', 'delete', 'void', 'typeof', 'instanceof', 'in', 'of', 'new', 'yield', 'await', 'else', 'do'].includes(word)
      continue
    }

    canBeRegex = '([{:;,=!?&|+-*%^~<>'.includes(ch)
    i++
  }
  return found
}

function initGitRepo(cwd) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  git('init', '-q')
  writeFileSync(join(cwd, 'README.md'), 'initial\n')
  git('add', 'README.md')
  git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'seed')
  return git
}

test('all 23 owned files in Track 1 contain strictly zero JS comments', () => {
  const ownedFiles = [
    'lib/store.mjs',
    'lib/slots.mjs',
    'lib/crew.mjs',
    'lib/map.mjs',
    'lib/stats.mjs',
    'lib/worktree.mjs',
    'lib/attachments.mjs',
    'lib/problems.mjs',
    'lib/pi-secrets.mjs',
    'lib/pi-profile.mjs',
    'lib/pi.mjs',
    'lib/native.mjs',
    'lib/stream-workers.mjs',
    'lib/templates.mjs',
    'lib/cli-process.mjs',
    'lib/credential-proxy.mjs',
    'lib/paths.mjs',
    'lib/platform/index.mjs',
    'lib/platform/launchd.mjs',
    'lib/platform/processes.mjs',
    'lib/platform/linux.mjs',
    'test/harness.mjs',
    'test/r2-engine.test.mjs'
  ]
  for (const rel of ownedFiles) {
    const content = readFileSync(join(repo, rel), 'utf8')
    const comments = findJsComments(content)
    assert.deepEqual(comments, [], 'Found unexpected comments in ' + rel + ': ' + JSON.stringify(comments))
  }
})

test('150-shard map + batched ticketRows + batchDetail completes in <500ms without O(Q^2) notification storm', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cc-bro-bench-')))
  const slots = new Slots(4)
  const store = new Store(false, join(dir, 'tickets.sqlite'))
  t.after(() => {
    store.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  let queueNotifyCount = 0
  const settings = {
    id: 'bench',
    repoPath: dir,
    allow: ['codex'],
    worker: 'codex',
    concurrency: 4,
    entries: { codex: { note: 'Bench note', rules: ['Worker rule'] } },
    rules: ['Global rule']
  }
  const crew = new Crew(store, slots, () => settings)
  crew.onQueueChange = () => { queueNotifyCount++ }

  const gates = new Map()
  crew.runNative = async (c, text, controller, ready) => {
    ready.resolve(null)
    store.stmt('UPDATE conversations SET native_id=?,transport=? WHERE id=?').run('s-' + c.name, 'app-server', c.id)
    store.event(c.id, c.turn, 'tool.started', { step: 1 }, 'rg ' + c.name)
    store.event(c.id, c.turn, 'usage', { cachedInputTokens: 500, inputTokens: 160000 }, '')
    const gate = Promise.withResolvers()
    gates.set(c.name, gate)
    controller.signal.addEventListener('abort', () => gate.resolve(), { once: true })
    await gate.promise
    if (controller.signal.aborted) {
      store.finish(c.id, c.turn, 'stopped', 'Stopped by manager')
      return
    }
    store.finish(c.id, c.turn, 'done', 'Waiting for manager', store.assistant(c.id, c.turn, 'Result for ' + c.name))
  }

  const inputs = Array.from({ length: 150 }, (_, i) => 'module-' + (i + 1) + '.mjs')
  const t0 = performance.now()
  const dispatched = await dispatchMap(crew, {
    prefix: 'sweep',
    title: '150-shard benchmark',
    brief: 'Audit {input} ({index}/{count})',
    inputs,
    defaultCwd: dir
  })
  await new Promise(resolve => queueMicrotask(resolve))
  const rows = store.ticketRows()
  const detail = batchDetail(store, 'sweep', { full: true })
  const elapsed = performance.now() - t0

  assert.equal(dispatched.count, 150)
  assert.equal(rows.length, 150)
  assert.equal(detail.count, 150)
  const budgetMs = process.platform === 'win32' ? 5000 : 500
  assert.ok(elapsed < budgetMs, 'Expected 150-shard map + ticketRows + batchDetail < ' + budgetMs + 'ms, got ' + Math.round(elapsed) + 'ms')
  assert.ok(queueNotifyCount <= 150, 'Expected coalesced linear notifications <= 150, got ' + queueNotifyCount)

  const activeRow = rows.find(r => r.id === 'sweep-1')
  assert.deepEqual(activeRow.batch, { prefix: 'sweep', index: 1, count: 150, input: 'module-1.mjs' })
  assert.equal(activeRow.currentStep, 'rg sweep-1')
  assert.ok(typeof activeRow.lastHeartbeatAt === 'string')
  assert.equal(activeRow.note, 'Bench note')
  assert.deepEqual(activeRow.rules, ['Global rule', 'Worker rule'])
  assert.equal(activeRow.capability, 'full')
  assert.equal(activeRow.contextWarning.actionable, false)
  assert.equal(activeRow.outcomeAt, null)

  const queuedRow = rows.find(r => r.id === 'sweep-11')
  assert.equal(queuedRow.queue.position, 7)
  assert.equal(queuedRow.queue.totalQueued, 146)

  await stopBatch(crew, 'sweep')
  for (const g of gates.values()) g.resolve()
  const closed = doneBatch(store, 'sweep', { result: 'blocked', why: 'Benchmark cleanup' })
  assert.equal(closed.closed.length, 150)
  const doneRows = store.ticketRows()
  assert.ok(typeof doneRows[0].outcomeAt === 'string' && !Number.isNaN(Date.parse(doneRows[0].outcomeAt)))
})

test('Store.transaction BEGIN IMMEDIATE honors busy_timeout instead of failing with SQLITE_BUSY_SNAPSHOT', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-bro-wal-'))
  const dbPath = join(dir, 'tickets.sqlite')
  const s1 = new Store(false, dbPath)
  const s2 = new Store(false, dbPath)
  t.after(() => {
    s1.db.close()
    s2.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const c = s1.create('concurrent', dir, 'gpt-6-astra', 'Concurrent txn', 'medium', 'codex')
  s2.transaction(() => {
    const read = s2.byName('concurrent')
    assert.equal(read.name, 'concurrent')
    const r = s2.accept(read, 'turn one')
    assert.equal(r.turn, 1)
  })
  s1.transaction(() => {
    const fresh = s1.byName('concurrent')
    s1.finish(fresh.id, 1, 'done', 'Completed', s1.assistant(fresh.id, 1, 'ok'))
  })
  assert.equal(s2.detail('concurrent').lastReply, 'ok')
})

test('Crew.record suppresses empty pi streaming deltas and Store.detail exposes rawSummary + recentMessages', t => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-bro-deltas-'))
  const store = new Store(false, join(dir, 'tickets.sqlite'))
  t.after(() => {
    store.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const crew = new Crew(store, new Slots(1), () => ({ repoPath: dir, allow: ['pi:deepseek'], worker: 'pi:deepseek' }))
  const c = store.create('stream-pi', dir, 'deepseek/a', 'Streaming test', null, 'pi:deepseek')
  store.accept(c, 'prompt 1')
  const w = { turn: 1, active: true, stopping: false, activity: '', sawAssistant: false, replyId: null, failure: '', initialSeen: true, settling: false, steers: [], settled: Promise.withResolvers() }

  for (let i = 0; i < 400; i++) {
    crew.record(c, w, { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 't' + i } })
  }
  for (let i = 0; i < 600; i++) {
    crew.record(c, w, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' + i } })
  }
  const updateEvents = store.stmt("SELECT summary FROM events WHERE cid=? AND kind='message_update'").all(c.id)
  assert.deepEqual(updateEvents.map(e => e.summary), ['Thinking', 'Writing reply'])

  for (let i = 0; i < 5; i++) {
    store.event(c.id, 1, 'tool.started', { step: 2 }, 'run_command: pytest')
  }
  for (let i = 2; i <= 14; i++) {
    store.message(c.id, 1, 'steer', 'msg-' + i)
  }

  const detail = store.detail('stream-pi')
  const collapsed = detail.timeline.find(t => t.rawSummary === 'run_command: pytest')
  assert.equal(collapsed.count, 5)
  assert.equal(collapsed.rawSummary, 'run_command: pytest')
  assert.match(collapsed.summary, /^run_command: pytest \(×5, last /)
  assert.equal(detail.recentMessages.length, 10)
  assert.equal(detail.recentMessages[0].content, 'msg-5')
  assert.equal(detail.recentMessages.at(-1).content, 'msg-14')
})

test('map partial failure trims batch shards, batchDetail supports status/full, and retryBatch retries only failed/stopped shards', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cc-bro-batch-ops-')))
  const slots = new Slots(3)
  const store = new Store(false, join(dir, 'tickets.sqlite'))
  t.after(() => {
    store.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  let count = 0
  const settings = { id: 'b-ops', repoPath: dir, allow: ['codex'], worker: 'codex', entries: {}, rules: [] }
  const crew = new Crew(store, slots, () => settings)
  const outcomesByShard = new Map()
  crew.runNative = async (c, text, controller, ready) => {
    ready.resolve(null)
    const mode = outcomesByShard.get(c.name) ?? 'done'
    if (mode === 'error') {
      store.finish(c.id, c.turn, 'error', '503 Service Unavailable')
      return
    }
    if (mode === 'stop') {
      store.finish(c.id, c.turn, 'stopped', 'Stopped by manager')
      return
    }
    store.stmt('UPDATE conversations SET native_id=?,transport=? WHERE id=?').run('sess-' + c.name, 'app-server', c.id)
    store.finish(c.id, c.turn, 'done', 'Waiting', store.assistant(c.id, c.turn, 'Full reply for ' + c.name + ': ' + 'x'.repeat(240)))
  }

  const origSay = crew.say.bind(crew)
  crew.say = async (input, review) => {
    if (input.name === 'partial-3' && ++count === 1) throw new Error('Simulated shard 3 failure')
    return origSay(input, review)
  }

  await assert.rejects(
    dispatchMap(crew, { prefix: 'partial', brief: 'Check {input}', inputs: ['1', '2', '3', '4'], defaultCwd: dir }),
    /Simulated shard 3 failure/
  )
  await until(() => batchDetail(store, 'partial').finished)
  const partialDetail = batchDetail(store, 'partial')
  assert.equal(partialDetail.count, 2)
  assert.equal(partialDetail.finished, true)

  outcomesByShard.set('mix-1', 'done')
  outcomesByShard.set('mix-2', 'error')
  outcomesByShard.set('mix-3', 'stop')
  outcomesByShard.set('mix-4', 'done')

  await dispatchMap(crew, { prefix: 'mix', brief: 'Inspect {input}', inputs: ['a', 'b', 'c', 'd'], defaultCwd: dir })
  await until(() => batchDetail(store, 'mix').finished)
  store.done('mix-4', { result: 'pass', why: 'ok' })

  const errOnly = batchDetail(store, 'mix', { status: 'error,stopped', full: true })
  assert.equal(errOnly.count, 4)
  assert.deepEqual(errOnly.shards.map(s => s.name), ['mix-2', 'mix-3'])
  const fullReview = batchDetail(store, 'mix', { status: ['review'], full: true })
  assert.equal(fullReview.shards.length, 1)
  assert.ok(fullReview.shards[0].reply.length > 240)
  assert.ok(fullReview.shards[0].replyPreview.length <= 200)

  outcomesByShard.set('mix-2', 'done')
  outcomesByShard.set('mix-3', 'done')
  const retryRes = await retryBatch(crew, 'mix', { effort: 'high' })
  assert.equal(retryRes.isBatch, true)
  assert.deepEqual(retryRes.retried.map(s => [s.name, s.turn, s.retriedTurn, s.effort]), [
    ['mix-2', 2, 1, 'high'],
    ['mix-3', 2, 1, 'high']
  ])
  assert.deepEqual(retryRes.skipped.map(s => [s.name, s.status]), [
    ['mix-1', 'review'],
    ['mix-4', 'done']
  ])
  await until(() => batchDetail(store, 'mix').counts.review === 3)

  const records = ticketRecords(store)
  assert.equal(records.length, 1)
  assert.equal(records[0].outcome, 'pass')
})

test('orphan-free worker lifecycle: runNative reaps background children + unlinks marker, done/idle-TTL/releaseAll/interruptRunning reap pi, and 0 launchd labels leak', async t => {
  const beforeLabels = process.platform === 'darwin'
    ? new Set((await exec('/bin/launchctl', ['list'])).stdout.split('\n').map(l => l.split('\t')[2]).filter(l => l?.startsWith('me.yanauto.broco.')))
    : new Set()

  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cc-bro-lifecycle-')))
  const store = new Store(false, join(dir, 'tickets.sqlite'))
  const slots = new Slots(2)
  t.after(async () => {
    store.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const bgPidFile = join(dir, 'bg-child.pid')
  const bgStdio = process.platform === 'win32' ? "'ignore'" : "['ignore', 'ignore', 'ignore', 3]"
  const fakeCustom = writeFakeCli(bin, 'bg-leaker', [
    "import { spawn } from 'node:child_process'",
    "import { writeFileSync } from 'node:fs'",
    `const bg = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ${bgStdio} })`,
    `writeFileSync(${JSON.stringify(bgPidFile)}, String(bg.pid))`,
    'bg.unref()',
    "console.log(JSON.stringify({ id: 'sess-bg', reply: 'done' }))"
  ])

  const prevPath = process.env.PATH
  process.env.PATH = bin + delimiter + prevPath
  try {
    const template = {
      command: fakeCustom,
      newArgs: ['{prompt}'],
      resumeArgs: ['{session}', '{prompt}'],
      format: 'jsonl',
      reply: { path: 'reply' },
      session: { path: 'id' }
    }
    const crew = new Crew(store, slots, () => ({
      id: 'lc',
      repoPath: dir,
      allow: ['custom:bg'],
      worker: 'custom:bg',
      entries: { 'custom:bg': { template } },
      rules: []
    }))
    await crew.say({ name: 'leak-test', text: 'spawn bg', defaultCwd: dir })
    await until(() => store.byName('leak-test').status === 'idle')
    const leakedPid = Number(readFileSync(bgPidFile, 'utf8').trim())
    assert.equal(alive(leakedPid), false)
    assert.equal(existsSync(store.marker(store.byName('leak-test').id)), false)
  } finally {
    process.env.PATH = prevPath
  }

  {
    const h = harness(t, false, { BROCO_CONCURRENCY: '1' })
    await h.cli('init', '--allow', 'pi:deepseek', '--default-worker', 'pi:deepseek')
    await h.cli('say', 'pi-done', 'hello', '--model', 'deepseek/a')
    const piPid = h.query("SELECT worker_pid FROM conversations WHERE name='pi-done'")[0].worker_pid
    assert.ok(alive(piPid))
    await h.cli('done', 'pi-done', '--result', 'pass')
    await until(() => !alive(piPid) && h.query("SELECT worker_pid FROM conversations WHERE name='pi-done'")[0].worker_pid === null)
    assert.equal(alive(piPid), false)
    assert.equal(await h.cli('say', 'pi-done', 'resumed', '--model', 'deepseek/a', '--new-task'), 'resumed')
    const resumedPid = h.query("SELECT worker_pid FROM conversations WHERE name='pi-done'")[0].worker_pid
    assert.ok(alive(resumedPid))
    await h.cli('shutdown')
    assert.equal(alive(resumedPid), false)
  }

  const idleRoot = realpathSync(mkdtempSync(join(repo, '.sandbox', 'idle-ttl-')))
  try {
    const subStore = new Store(false, join(idleRoot, 'tickets.sqlite'))
    const subSlots = new Slots(1)
    let fakeReleased = 0
    const subCrew = new Crew(subStore, subSlots, () => ({ id: 'idle', repoPath: idleRoot, allow: ['pi:deepseek'], worker: 'pi:deepseek' }))
    subCrew.idleTimeoutMs = 50
    const c = subStore.create('idle-one', idleRoot, 'deepseek/a', 'Idle', null, 'pi:deepseek')
    subStore.accept(c, 'work')
    subStore.claim(subStore.byName('idle-one'))
    subCrew.workers.set(c.id, { active: false, stopping: false, exited: true, child: { stdin: { end() {} } }, closed: Promise.resolve() })
    const origRelease = subCrew.release.bind(subCrew)
    subCrew.release = async (conv, w) => {
      const res = await origRelease(conv, w)
      fakeReleased++
      return res
    }
    subStore.finish(c.id, 1, 'done', 'Done')
    await until(() => fakeReleased === 1)
    assert.equal(subCrew.workers.has(c.id), false)

    const cRun = subStore.create('sig-run', idleRoot, 'codex', 'Running', null, 'codex')
    subStore.accept(cRun, 'active')
    subStore.claim(subStore.byName('sig-run'))
    const controller = new AbortController()
    subCrew.native.set(cRun.id, { controller, task: Promise.resolve(), ready: Promise.withResolvers() })

    const cQueued = subStore.create('sig-queued', idleRoot, 'codex', 'Queued', null, 'codex')
    subStore.accept(cQueued, 'wait')

    await subCrew.interruptRunning('Runner interrupted by SIGTERM')
    assert.equal(controller.signal.aborted, true)
    assert.equal(subStore.byName('sig-run').status, 'error')
    assert.match(subStore.result(cRun.id, 1).error, /SIGTERM/)
    assert.equal(subStore.byName('sig-queued').status, 'queued')

    await subCrew.releaseAll()
    subStore.db.close()
  } finally {
    rmSync(idleRoot, { recursive: true, force: true })
  }

  if (process.platform === 'darwin') {
    const afterLabels = (await exec('/bin/launchctl', ['list'])).stdout.split('\n').map(l => l.split('\t')[2]).filter(l => l?.startsWith('me.yanauto.broco.'))
    const leaked = afterLabels.filter(l => !beforeLabels.has(l))
    assert.deepEqual(leaked, [], 'Leaked launchd labels: ' + leaked.join(', '))
  }
})

test('worktree async changes, diffWorktree (tracked + untracked + statOnly), cleanWorktrees, and gcAttachments', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cc-bro-wt-gc-')))
  const repoDir = join(dir, 'repo')
  const stateDir = join(dir, 'state')
  mkdirSync(repoDir)
  mkdirSync(stateDir)
  const store = new Store(false, join(stateDir, 'tickets.sqlite'))
  t.after(() => {
    store.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const git = initGitRepo(repoDir)
  const base = baseline(repoDir)
  writeFileSync(join(repoDir, 'README.md'), 'modified line\n')
  writeFileSync(join(repoDir, 'untracked.txt'), 'brand new content\n')

  assert.deepEqual(await changesAsync(repoDir, base), changes(repoDir, base))

  const fullDiff = diffWorktree(repoDir, base)
  assert.equal(fullDiff.baseHead, base.head)
  assert.deepEqual(fullDiff.changedFiles, [
    { path: 'README.md', status: 'M' },
    { path: 'untracked.txt', status: 'A' }
  ])
  assert.match(fullDiff.stat, /README\.md/)
  assert.match(fullDiff.stat, /untracked\.txt \| new untracked file/)
  assert.match(fullDiff.patch, /\+modified line/)
  assert.match(fullDiff.patch, /\+brand new content/)

  const statDiff = diffWorktree(repoDir, base, { statOnly: true })
  assert.equal(statDiff.patch, null)
  assert.match(statDiff.stat, /README\.md/)
  git('checkout', '--', 'README.md')
  rmSync(join(repoDir, 'untracked.txt'))

  const treeClean = createTree(repoDir, stateDir, 'clean-job')
  const cClean = store.create('clean-job', treeClean.cwd, 'codex', 'Clean WT', null, 'codex')
  store.stmt('INSERT INTO collaboration(cid,worktree,branch) VALUES (?,?,?)').run(cClean.id, treeClean.worktree, treeClean.branch)
  store.accept(cClean, 'work')
  store.finish(cClean.id, 1, 'done', 'Done', store.assistant(cClean.id, 1, 'ok'))
  store.done('clean-job', { result: 'pass' })

  const treeDirty = createTree(repoDir, stateDir, 'dirty-job')
  writeFileSync(join(treeDirty.worktree, 'uncommitted.txt'), 'wip\n')
  const cDirty = store.create('dirty-job', treeDirty.cwd, 'codex', 'Dirty WT', null, 'codex')
  store.stmt('INSERT INTO collaboration(cid,worktree,branch) VALUES (?,?,?)').run(cDirty.id, treeDirty.worktree, treeDirty.branch)
  store.accept(cDirty, 'work')
  store.finish(cDirty.id, 1, 'done', 'Done', store.assistant(cDirty.id, 1, 'ok'))
  store.done('dirty-job', { result: 'pass' })

  const dry = cleanWorktrees(store, repoDir, { dryRun: true, deleteBranch: true })
  assert.deepEqual(dry.cleaned.map(x => x.name), ['clean-job'])
  assert.deepEqual(dry.skipped.map(x => x.name), ['dirty-job'])
  assert.equal(existsSync(treeClean.worktree), true)

  const actual = cleanWorktrees(store, repoDir, { deleteBranch: true })
  assert.deepEqual(actual.cleaned.map(x => [x.name, x.branchDeleted]), [['clean-job', true]])
  assert.equal(existsSync(treeClean.worktree), false)
  assert.equal(store.meta(cClean.id).worktree, null)
  assert.equal(store.meta(cClean.id).branch, null)

  const forced = cleanWorktrees(store, repoDir, { target: 'dirty-job', force: true, deleteBranch: true })
  assert.equal(forced.cleaned.length, 1)
  assert.equal(existsSync(treeDirty.worktree), false)

  const imgUsed = join(dir, 'used.png')
  const imgOrphan = join(dir, 'orphan.png')
  writeFileSync(imgUsed, TINY_PNG)
  writeFileSync(imgOrphan, Buffer.concat([TINY_PNG, Buffer.from('extra')]))
  const [snapUsed] = snapshotAttachments(describeAttachments([imgUsed]), stateDir)
  const [snapOrphan] = snapshotAttachments(describeAttachments([imgOrphan]), stateDir)
  store.stmt('UPDATE turns SET execution=? WHERE cid=? AND turn=1').run(JSON.stringify({ attachments: [snapUsed] }), cClean.id)

  const gcDry = gcAttachments(store, { dryRun: true })
  assert.equal(gcDry.removed, 1)
  assert.equal(existsSync(snapOrphan.path), true)

  const gcReal = gcAttachments(store)
  assert.equal(gcReal.removed, 1)
  assert.equal(existsSync(snapOrphan.path), false)
  assert.equal(existsSync(snapUsed.path), true)
})

test('security hardening, agy singleflight + resetEpoch fix, and problems.mjs real provider classifications', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cc-bro-sec-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const sock = socketFor(join(dir, 'home'))
  if (process.platform === 'win32') {
    assert.match(sock, /^\\\\\.\\pipe\\broco-[0-9a-f]{24}$/)
  } else {
    const sockParent = realpathSync(join(sock, '..'))
    const st = lstatSync(sockParent)
    assert.equal(st.uid, process.getuid())
    assert.equal(st.mode & 0o077, 0)
  }

  assert.throws(() => proxyConfig({
    upstream: 'http://127.0.0.1:9999',
    paths: ['/'],
    header: 'Authorization',
    maxRequests: 10,
    ttl: 30
  }), /--path/)

  let seenUrl = null
  const server = createServer((req, res) => { seenUrl = req.url; res.end('ok') })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const proxies = new CredentialProxies(() => {})
  t.after(async () => { await proxies.closeAll(); server.close() })
  const opened = await proxies.open({
    upstream: 'http://127.0.0.1:' + server.address().port,
    paths: ['/v1/models'],
    header: 'X-API-Key',
    value: 'super-secret-value-1234',
    maxRequests: 5,
    ttl: 30
  })
  const resp = await fetch(opened.url + '/%76%31/models?limit=2')
  assert.equal(resp.status, 200)
  assert.equal(seenUrl, '/v1/models?limit=2')

  const env = {
    DEEPSEEK_API_KEY: 'aaaa-aaaa-aaaa',
    PGPASSWORD: 'bbbb-bbbb-bbbb',
    SSH_PRIVATE_KEY: 'cccc-cccc-cccc'
  }
  const secrets = secretsFrom([{ headers: { 'api-key': 'dddd-dddd-dddd' } }], env)
  const parsed = parseRedactedJson(JSON.stringify({
    headers: { 'api-key': 'dddd-dddd-dddd', cookie: 'sid=11111' },
    output: 'leaked aaaa-aaaa-aaaa and bbbb-bbbb-bbbb and cccc-cccc-cccc'
  }), secrets)
  assert.equal(parsed.headers['api-key'], '[redacted]')
  assert.equal(parsed.headers.cookie, '[redacted]')
  assert.equal(parsed.output, 'leaked [redacted] and [redacted] and [redacted]')
  assert.equal(redactStderr('Error: password=bbbb-bbbb-bbbb user@example.com', env), 'Error: [redacted] [account]')

  assert.deepEqual(agyModel('gemini-pro-orchestrator', 'high', ['gemini-pro-orchestrator', 'gemini-pro-orchestrator-argon']), {
    model: 'gemini-pro-orchestrator',
    effortFlag: 'high'
  })
  assert.deepEqual(agyModel('gemini-pro-orchestrator', 'high', []), {
    model: 'gemini-pro-orchestrator',
    effortFlag: 'high'
  })

  assert.equal(resetEpoch({
    windows: [
      { minutes: 300, usedPercent: 10, resetsAt: '2026-11-18T06:00:00Z' },
      { minutes: 10080, usedPercent: 65, resetsAt: '2026-11-24T06:00:00Z' }
    ]
  }, '429 Too Many Requests'), null)
  assert.equal(resetEpoch({
    windows: [
      { minutes: 300, usedPercent: 0, resetsAt: '2026-11-18T06:00:00Z' },
      { minutes: 10080, usedPercent: 65, resetsAt: '2026-11-24T06:00:00Z' }
    ]
  }, 'RESOURCE_EXHAUSTED: quota exceeded'), null)
  assert.equal(resetEpoch({
    windows: [
      { minutes: 300, usedPercent: 15, resetsAt: '2026-11-18T06:00:00Z' },
      { minutes: 10080, usedPercent: 100, resetsAt: '2026-11-24T06:00:00Z' }
    ]
  }, 'RESOURCE_EXHAUSTED: quota exceeded'), Math.floor(Date.parse('2026-11-24T06:00:00Z') / 1000))

  const bin = join(dir, 'agy-bin')
  mkdirSync(bin)
  const counterFile = join(dir, 'usage-probes.txt')
  writeFakeCli(bin, 'agy', [
    "import { appendFileSync } from 'node:fs'",
    'const args = process.argv.slice(2)',
    "if (args.includes('/usage')) {",
    `  appendFileSync(${JSON.stringify(counterFile)}, '1\\n')`,
    '  await new Promise(r => setTimeout(r, 40))',
    "  console.log(JSON.stringify({ groups: [{ name: 'Gemini Models', buckets: [{ id: 'g', window: '5h', remaining_fraction: 0.9, reset_time: '2026-11-18T06:00:00Z' }] }] }))",
    '  process.exit(0)',
    '}',
    "for await (const _ of process.stdin) {}",
    'await new Promise(r => setTimeout(r, 80))',
    "console.log(JSON.stringify({ event: 'init', conversation_id: 'c-1' }))",
    "console.log(JSON.stringify({ event: 'result', result: { conversation_id: 'c-1', status: 'SUCCESS', response: 'ok eeee-eeee-eeee' } }))"
  ])

  const prevPath = process.env.PATH
  process.env.PATH = bin + delimiter + prevPath
  process.env.CUSTOM_TEST_SECRET = 'eeee-eeee-eeee'
  clearAgyUsageCache()
  try {
    const replies = await Promise.all(Array.from({ length: 6 }, (_, idx) => streamTurn({
      provider: 'agy',
      model: 'gemini-4-argon-medium',
      thinking: null,
      cwd: dir,
      marker: join(dir, 'm-' + idx),
      text: 'go',
      signal: new AbortController().signal,
      owner() {},
      ready() {},
      bind() {},
      event() {}
    })))
    assert.equal(replies[0], 'ok [redacted]')
    const totalProbes = readFileSync(counterFile, 'utf8').trim().split('\n').length
    assert.equal(totalProbes, 7, 'Expected 1 shared pre-turn probe + 6 post-turn probes = 7 total (not 12)')
  } finally {
    process.env.PATH = prevPath
    delete process.env.CUSTOM_TEST_SECRET
    clearAgyUsageCache()
  }

  const providerErrors = [
    ['RESOURCE_EXHAUSTED: No capacity available for model gemini-4-argon-high', 'network', true],
    ['Error 429: RESOURCE_EXHAUSTED - The model is overloaded, try again later', 'network', true],
    ['1302: 并发数过高，请稍后重试', 'network', true],
    ['HTTP 500 Internal Server Error', 'network', true],
    ['529 Overloaded: overloaded_error', 'network', true],
    ['{"error":{"code":"unsupported_country_region_territory","message":"Country, region, or territory not supported"}}', 'region', false],
    ['Error: invalid_api_key: Incorrect API key provided: sk-1234', 'auth', false],
    ['Anthropic authentication_error: invalid x-api-key', 'auth', false],
    ['pi auth could not resolve an API key for deepseek', 'auth', false],
    ['No API-key credential for zai', 'auth', false],
    ['Sign in to this provider in the sandbox pi profile.', 'auth', false],
    ['1002: 无效的API Key', 'auth', false],
    ['1113: 余额不足或无可用资源包,请充值', 'quota', true],
    ['Insufficient account balance', 'quota', true],
    ['input length and max_tokens exceed context limit: 205000 > 200000', 'context', false],
    ['The input token count (1050123) exceeds the maximum number of tokens allowed (1048576)', 'context', false],
    ['InvalidRequestError: input tokens exceed max_input_tokens', 'context', false],
    ['Candidate blocked: finishReason: SAFETY', 'policy', false],
    ['FINISH_REASON_PROHIBITED_CONTENT', 'policy', false],
    ['1301: 系统检测到输入或生成内容可能包含不安全或敏感内容', 'policy', false]
  ]
  for (const [msg, expectedClass, expectedRetryable] of providerErrors) {
    const p = classify(msg)
    assert.equal(p.class, expectedClass, 'Misclassified: ' + msg)
    assert.equal(p.retryable, expectedRetryable, 'Wrong retryable for: ' + msg)
  }
})
