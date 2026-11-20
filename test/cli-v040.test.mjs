import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { repo } from '../lib/paths.mjs'
import { Store } from '../lib/store.mjs'
import { harness } from './harness.mjs'

test('version flags and subcommand work without starting runner both inside and outside git', async t => {
  const h = harness(t)
  for (const args of [['--version'], ['-v'], ['version']]) {
    const out = await h.cli(...args)
    assert.match(out, /^1\.0\.0 \([0-9a-f]{7,12}\)$/)
  }
  const vJson = await h.json('version')
  assert.equal(vJson.version, '1.0.0')
  assert.match(vJson.commit, /^[0-9a-f]{7,12}$/)
  assert.deepEqual(await h.json('--version'), vJson)
  assert.equal(existsSync(h.data), false)
  assert.equal(await h.runnerPid().catch(() => null), null)

  const standalone = mkdtempSync(join(tmpdir(), 'broco-nogit-'))
  try {
    for (const item of ['bin', 'lib', 'package.json']) {
      cpSync(join(repo, item), join(standalone, item), { recursive: true })
    }
    const text = execFileSync(process.execPath, [join(standalone, 'bin/broco'), '--version'], {
      cwd: standalone,
      encoding: 'utf8'
    }).trim()
    assert.equal(text, '1.0.0')
    const json = JSON.parse(execFileSync(process.execPath, [join(standalone, 'bin/broco'), 'version', '--json'], {
      cwd: standalone,
      encoding: 'utf8'
    }))
    assert.deepEqual(json, { version: '1.0.0', commit: null })
  } finally {
    rmSync(standalone, { recursive: true, force: true })
  }
})

test('init manages CLAUDE.md and concurrency, supports --no-claude-md, and uninit cleans up cleanly', async t => {
  const h = harness(t)
  const skipped = await h.json('init', '--allow', 'codex', '--no-claude-md')
  assert.equal(skipped.claudeMd, undefined)
  assert.equal(existsSync(join(h.cwd, 'CLAUDE.md')), false)
  assert.equal(existsSync(join(h.cwd, '.broco', 'project-id')), true)

  const removed1 = await h.json('uninit')
  assert.equal(removed1.unregistered, true)
  assert.equal(removed1.markerRemoved, true)
  assert.equal(existsSync(join(h.cwd, '.broco')), false)

  writeFileSync(join(h.cwd, 'CLAUDE.md'), '# Project Rules\n\nKeep code clean.\n')
  const initText = await h.cli('init', '--allow', 'codex', '--concurrency', '6')
  assert.match(initText, /concurrency: 6/)
  assert.match(initText, /CLAUDE\.md: appended/)
  const md = readFileSync(join(h.cwd, 'CLAUDE.md'), 'utf8')
  assert.match(md, /^# Project Rules\n\nKeep code clean\.\n\n<!-- broco:start -->[\s\S]*<!-- broco:end -->\n$/)

  const rosterTextOut = await h.cli('roster', '--refresh')
  assert.match(rosterTextOut, /^Default bro: codex · concurrency=6 · compact/m)
  assert.equal((await h.json('roster')).concurrency, 6)

  const uninitText = await h.cli('uninit')
  assert.match(uninitText, /Unregistered project/)
  assert.match(uninitText, /CLAUDE\.md: stripped/)
  assert.equal(existsSync(join(h.cwd, '.broco')), false)
  assert.equal(readFileSync(join(h.cwd, 'CLAUDE.md'), 'utf8'), '# Project Rules\n\nKeep code clean.\n')
  await assert.rejects(h.cli('ls'), /not registered/)
})

test('direct agent-first config commands apply immediately, record timestamped audit entries, and support undo', async t => {
  const h = harness(t, false, { BROCO_TZ: 'UTC' })
  writeFileSync(join(h.cwd, 'fixture-models.json'), JSON.stringify([
    { model: 'gpt-6-astra', inputModalities: ['text', 'image'] },
    { model: 'gpt-6.1-sol', inputModalities: ['text', 'image'] }
  ]))

  const globalConc = await h.json('set', 'concurrency', '5', '--global')
  assert.equal(globalConc.concurrency, 5)
  const globalRule = await h.json('rules', '--add', 'Always run tests', '--global')
  assert.deepEqual(globalRule.rules, ['Always run tests'])

  await h.json('init', '--allow', 'codex')
  assert.equal((await h.json('roster')).concurrency, 5)
  assert.deepEqual((await h.json('rules')).rules, ['Always run tests'])

  const allowText = await h.cli('allow', 'agy,pi:deepseek', '--default-worker', 'agy')
  assert.match(allowText, /\(audit #\d+; undo: broco undo \d+\)/)
  assert.equal((await h.json('roster')).defaultWorker, 'agy')

  await h.cli('set', 'default-worker', 'codex')
  assert.equal((await h.json('roster')).defaultWorker, 'codex')

  await h.cli('deny', 'pi:deepseek')
  assert.equal((await h.json('roster')).workers.find(w => w.id === 'pi:deepseek').allowed, false)

  await h.cli('set', 'concurrency', '4')
  assert.equal((await h.json('roster')).concurrency, 4)
  await h.cli('set', 'concurrency', 'inherit')
  assert.equal((await h.json('roster')).concurrency, 5)

  const defOut = await h.cli('defaults', 'codex', '--model', 'gpt-6-astra', '--effort', 'high')
  assert.match(defOut, /effective model=gpt-6-astra, effort=high \(audit #\d+/)
  assert.equal((await h.json('roster')).workers.find(w => w.id === 'codex').defaultModel, 'gpt-6-astra')
  await h.cli('defaults', 'codex', '--clear')
  assert.notEqual((await h.json('roster')).workers.find(w => w.id === 'codex').defaultModel, 'gpt-6-astra')
  await h.cli('undo')
  assert.equal((await h.json('roster')).workers.find(w => w.id === 'codex').defaultModel, 'gpt-6-astra')

  await h.cli('note', 'codex', 'Primary backend writer')
  assert.equal((await h.json('roster')).workers.find(w => w.id === 'codex').note, 'Primary backend writer')
  await h.cli('note', 'codex', '--clear')
  assert.equal((await h.json('roster')).workers.find(w => w.id === 'codex').note, '')
  await h.cli('undo')
  assert.equal((await h.json('roster')).workers.find(w => w.id === 'codex').note, 'Primary backend writer')

  await h.cli('rules', '--add', 'Keep diffs minimal', '--add', 'Zero comments')
  await h.cli('rules', '--worker', 'codex', '--add', 'Prefer native tools')
  const rulesText = await h.cli('rules')
  assert.match(rulesText, /Rule: Always run tests/)
  assert.match(rulesText, /Rule: Keep diffs minimal/)
  assert.match(rulesText, /Rule \(codex\): Prefer native tools/)
  assert.match(await h.cli('rules', '--worker', 'codex'), /Rule \(codex\): Prefer native tools/)
  await h.cli('rules', '--rm', 'Keep diffs minimal')
  assert.equal((await h.json('rules')).rules.includes('Keep diffs minimal'), false)

  assert.equal((await h.json('roster', '--worker', 'codex')).workers[0].models.length, 2)
  await h.cli('hide', 'codex', 'gpt-6.1-sol')
  assert.deepEqual((await h.json('roster', '--worker', 'codex')).workers[0].models.map(m => m.id), ['gpt-6-astra'])
  await h.cli('unhide', 'codex', 'gpt-6.1-sol')
  assert.equal((await h.json('roster', '--worker', 'codex')).workers[0].models.length, 2)

  const allAudit = await h.json('audit', '--all', '--limit', '50')
  assert.ok(allAudit.length >= 10)
  assert.match(await h.cli('audit', '--limit', '5'), /^ID\tTIME \(UTC\)\tSCOPE/m)

  const undoneGlobal = await h.json('undo', String(globalConc.auditId))
  assert.equal(undoneGlobal.undoneId, globalConc.auditId)
  assert.equal((await h.json('roster')).concurrency, 3)
})

test('map fan-out handles shell-expanded file globs, brief files, batch show, batch wait, stop, and done', async t => {
  const h = harness(t)
  await h.json('init', '--allow', 'codex', '--concurrency', '2')

  const briefPath = join(h.cwd, 'brief.md')
  writeFileSync(briefPath, 'Tag shard {index} of {count} at {input}')
  const shardFiles = ['shard-1.jsonl', 'shard-2.jsonl', 'shard-3.jsonl'].map(name => {
    const p = join(h.cwd, name)
    writeFileSync(p, '{"id":1}\n')
    return p
  })

  const dispatched = await h.json(
    'map',
    'x-tag',
    '--brief',
    'brief.md',
    '--inputs',
    'shard-1.jsonl',
    'shard-2.jsonl',
    'shard-3.jsonl',
    '--worker',
    'codex',
    '--bg'
  )
  assert.equal(dispatched.prefix, 'x-tag')
  assert.equal(dispatched.count, 3)
  assert.deepEqual(dispatched.shards.map(s => s.input), shardFiles)

  const waited = await h.json('wait', 'x-tag')
  assert.equal(waited.isBatch, true)
  assert.equal(waited.finished, true)
  assert.equal(waited.counts.review, 3)
  assert.equal(waited.shards[0].replyPreview, 'Tag shard 1 of 3 at ' + shardFiles[0])
  assert.equal(waited.shards[2].replyPreview, 'Tag shard 3 of 3 at ' + shardFiles[2])

  const shownText = await h.cli('show', 'x-tag')
  assert.match(shownText, /^Batch x-tag · 3 shards/m)
  assert.match(shownText, /x-tag-1\treview\t1/)

  const closed = await h.json('done', 'x-tag', '--result', 'pass', '--why', 'All 3 shards verified')
  assert.equal(closed.closed.length, 3)
  assert.equal(closed.skipped.length, 0)
  assert.ok((await h.json('ls')).every(row => row.status === 'done' && row.outcome === 'pass'))

  await h.json('map', 'x-stop', '--brief', '{input}', '--inputs', 'hold,hold', '--worker', 'codex', '--bg')
  const stopped = await h.json('stop', 'x-stop')
  assert.equal(stopped.stopped.length, 2)
  await assert.rejects(h.cli('wait', 'x-stop'), /shards failed or stopped/)
  const closedBlocked = await h.json('done', 'x-stop', '--result', 'blocked', '--why', 'Cancelled batch')
  assert.equal(closedBlocked.closed.length, 2)
})

test('optional turn on wait, queue details in say ack, unbound-session warning, and retry with model fixup', async t => {
  const h = harness(t)
  await h.json('init', '--allow', 'codex,agy', '--default-worker', 'codex', '--concurrency', '1')

  await h.json('say', 'blocker', 'hold', '--bg')
  const queuedAck = await h.cli('say', 'queued-one', 'hello after queue', '--bg')
  assert.match(queuedAck, /Queued \(#1 of 1, limit 1; active: blocker\)/)
  assert.match(await h.cli('show', 'queued-one'), /Queued \(#1 of 1, limit 1; active: blocker\)/)

  await h.cli('say', 'blocker', 'finish')
  assert.equal(await h.cli('wait', 'queued-one'), 'hello after queue')

  await h.json('say', 'blocker-2', 'hold', '--bg')
  await h.json('say', 'retry-me', 'original stored prompt', '--worker', 'agy', '--bg')
  await h.json('say', 'unbound-warn', 'lost first prompt', '--worker', 'agy', '--bg')
  await h.cli('deny', 'agy')
  await h.cli('stop', 'blocker-2')
  await assert.rejects(h.cli('wait', 'retry-me'), /no longer allowed/)
  await assert.rejects(h.cli('wait', 'unbound-warn'), /no longer allowed/)

  const failedShow = await h.json('show', 'retry-me')
  assert.equal(failedShow.session, null)
  assert.match(failedShow.sessionWarning, /broco retry retry-me/)
  assert.match(await h.cli('show', 'retry-me'), /broco retry retry-me/)

  await h.cli('allow', 'agy')
  const retried = await h.json('retry', 'retry-me', '--model', 'gemini-4-argon-high')
  assert.equal(retried.retriedTurn, 1)
  assert.equal(retried.turn, 2)
  assert.equal(retried.model, 'gemini-4-argon-high')
  assert.equal(retried.reply, 'original stored prompt')

  const warnReceipt = await h.json('say', 'unbound-warn', 'second prompt with full context', '--bg')
  assert.equal(warnReceipt.previousSessionBound, false)
  assert.match(warnReceipt.sessionWarning, /上一轮未建立原生会话/)
  assert.equal(await h.cli('wait', 'unbound-warn'), 'second prompt with full context')
})


test('done --result pass|rework on error/stopped tickets succeeds; bare done still rejects', async t => {
  const h = harness(t)
  await h.json('init', '--allow', 'codex', '--concurrency', '1')

  await h.json('say', 'blocker', 'hold', '--bg')
  await h.json('say', 'err-ticket', 'will error', '--bg')
  await h.cli('deny', 'codex')
  await h.cli('stop', 'blocker')
  await assert.rejects(h.cli('wait', 'err-ticket'), /no longer allowed/)
  await h.cli('allow', 'codex')

  const errShow = await h.json('show', 'err-ticket')
  assert.equal(errShow.flag, 'error')

  await assert.rejects(h.cli('done', 'err-ticket'), /Only tickets in review/)

  const passResult = await h.json('done', 'err-ticket', '--result', 'pass', '--why', 'deliverable verified complete')
  assert.equal(passResult.outcome, 'pass')
  assert.equal(passResult.outcomeReason, 'deliverable verified complete')
  assert.equal(passResult.status, 'done')

  await h.json('say', 'stop-ticket', 'will stop', '--bg')
  await h.cli('stop', 'stop-ticket')
  await assert.rejects(h.cli('done', 'stop-ticket'), /Only tickets in review/)
  const reworkResult = await h.json('done', 'stop-ticket', '--result', 'rework', '--why', 'partial output reviewed')
  assert.equal(reworkResult.outcome, 'rework')
  assert.equal(reworkResult.status, 'done')
})

test('runner_state table records lifecycle, signal shutdown preserves queued turns', async t => {
  const h = harness(t)
  await h.json('init', '--allow', 'codex', '--concurrency', '1')

  await h.json('say', 'running-one', 'hold', '--bg')
  await h.json('say', 'queued-one', 'queued task', '--bg')

  const pid = await h.runnerPid()
  const registryPath = join(h.data, 'registry-v2.sqlite')

  {
    const db = new DatabaseSync(registryPath, { readOnly: true })
    const state = db.prepare('SELECT * FROM runner_state WHERE id=1').get()
    db.close()
    assert.ok(state)
    assert.equal(state.pid, pid)
    assert.equal(state.stop_reason, null)
    assert.ok(state.started > 0)
  }

  process.kill(pid, 'SIGTERM')
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    try { process.kill(pid, 0) } catch { break }
    await new Promise(r => setTimeout(r, 80))
  }

  {
    const db = new DatabaseSync(registryPath, { readOnly: true })
    const afterState = db.prepare('SELECT * FROM runner_state WHERE id=1').get()
    db.close()
    assert.match(afterState.stop_reason, /signal:SIGTERM/)
    assert.ok(afterState.stopped > 0)
  }

  const projectId = readFileSync(join(h.cwd, '.broco', 'project-id'), 'utf8').trim()
  {
    const ticketsDb = new DatabaseSync(join(h.data, 'projects', projectId, 'tickets.sqlite'), { readOnly: true })
    const queuedRow = ticketsDb.prepare("SELECT status FROM conversations WHERE name='queued-one'").get()
    const runningRow = ticketsDb.prepare("SELECT c.status,t.error FROM conversations c LEFT JOIN turns t ON t.cid=c.id AND t.turn=c.turn WHERE c.name='running-one'").get()
    ticketsDb.close()
    assert.equal(queuedRow.status, 'queued')
    assert.notEqual(runningRow.status, 'running')
    assert.match(runningRow.error, /SIGTERM/)
  }
})

test('crash recovery records previous runner PID in problem.message', async t => {
  const h = harness(t)
  await h.json('init', '--allow', 'codex', '--concurrency', '1')

  await h.json('say', 'crash-victim', 'hold', '--bg')
  const pid = await h.runnerPid()

  process.kill(pid, 'SIGKILL')
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    try { process.kill(pid, 0) } catch { break }
    await new Promise(r => setTimeout(r, 80))
  }

  const result = await h.json('show', 'crash-victim')
  assert.match(result.activity, /pid/)
  assert.match(result.activity, /inspect work/)
})

test('reconcileQueue dispatches stranded queued turns after slot release', async t => {
  const h = harness(t)
  await h.json('init', '--allow', 'codex', '--concurrency', '1')

  await h.json('say', 'blocker', 'hold first', '--bg')
  await h.json('say', 'stranded', 'queued task', '--bg')

  await h.cli('say', 'blocker', 'finish')
  const reply = await h.cli('wait', 'stranded')
  assert.equal(reply, 'queued task')
})

test('store.done accepts any result on error/stopped but bare done rejects', t => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-bro-done-'))
  const path = join(dir, 'tickets.sqlite')
  const store = new Store(false, path)
  t.after(() => { store.db.close(); rmSync(dir, { recursive: true, force: true }) })

  const c = store.create('err-name', dir, 'model-a', 'task', 'high', 'codex')
  store.accept(c, 'work')
  store.finish(c.id, 1, 'error', 'Runner interrupted')

  assert.throws(() => store.done('err-name'), /Only tickets in review/)
  assert.throws(() => store.done('err-name', {}), /Only tickets in review/)

  const result = store.done('err-name', { result: 'pass', why: 'verified complete' })
  assert.equal(result.outcome, 'pass')
  assert.equal(result.outcomeReason, 'verified complete')

  const c2 = store.create('stop-name', dir, 'model-a', 'task2', 'high', 'codex')
  store.accept(c2, 'work2')
  store.finish(c2.id, 1, 'stopped', 'Stopped by signal')

  const result2 = store.done('stop-name', { result: 'rework', why: 'partial' })
  assert.equal(result2.outcome, 'rework')

  const c3 = store.create('blocked-name', dir, 'model-a', 'task3', 'high', 'codex')
  store.accept(c3, 'work3')
  store.finish(c3.id, 1, 'error', 'quota exceeded')
  const result3 = store.done('blocked-name', { result: 'blocked', why: 'quota' })
  assert.equal(result3.outcome, 'blocked')

  const c4 = store.create('fail-name', dir, 'model-a', 'task4', 'high', 'codex')
  store.accept(c4, 'work4')
  store.finish(c4.id, 1, 'stopped', 'Stopped')
  const result4 = store.done('fail-name', { result: 'fail', why: 'unusable' })
  assert.equal(result4.outcome, 'fail')
})
