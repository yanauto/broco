import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Store } from '../lib/store.mjs'
import { Crew } from '../lib/crew.mjs'
import { summarize, ticketRecords } from '../lib/stats.mjs'
import { rosterOutput, rosterText } from '../lib/roster-output.mjs'
import { commandHelp, parseCommand } from '../lib/cli-args.mjs'
import { harness } from './harness.mjs'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-bro-tasks-'))
  const path = join(dir, 'tickets.sqlite')
  const store = new Store(false, path)
  t.after(() => { store.db.close(); rmSync(dir, { recursive: true, force: true }) })
  const c = store.create('e2ee-proxy', dir, 'model-a', 'channel', 'high', 'codex')
  const run = (newTask = false, title, problem) => {
    const receipt = store.accept(store.byName(c.name), title || 'work', title, newTask)
    store.finish(c.id, receipt.turn, problem ? 'error' : 'done', problem || 'Review')
    store.stmt('UPDATE turns SET started=?,finished=? WHERE cid=? AND turn=?').run(1000, 61000, c.id, receipt.turn)
    for (const usedPercent of [10, 12]) store.event(c.id, receipt.turn, 'quota', { windows: [{ minutes: 10080, usedPercent, resetsAt: 'same' }] })
    return receipt
  }
  return { store, c, path, run }
}

test('three independent tasks on one name retain outcomes, ranges, quota and roster counts', t => {
  const { store, c, run } = fixture(t)
  assert.equal(run().task, 1)
  store.done(c.name, { result: 'pass', why: 'channel accepted' })
  assert.equal(run(true, 'text protocol').task, 2)
  assert.equal(store.done(c.name).outcome, 'pass')
  store.done(c.name, { result: 'pass', why: 'protocol accepted' })
  run(true, 'swallowed output')
  run()
  assert.equal(store.done(c.name).outcome, 'rework')
  store.done(c.name, { result: 'rework', why: 'needed regression coverage' })
  const tasks = store.detail(c.name).tasks
  assert.deepEqual(tasks.map(t => t.title), ['channel', 'text protocol', 'swallowed output'])
  assert.deepEqual(tasks.map(t => [t.task, t.startTurn, t.endTurn, t.outcome, t.outcomeReason]), [
    [1, 1, 1, 'pass', 'channel accepted'], [2, 2, 2, 'pass', 'protocol accepted'], [3, 3, 4, 'rework', 'needed regression coverage']
  ])
  const records = ticketRecords(store)
  assert.deepEqual(records.map(r => [r.turns, r.minutes, r.weekQuota]), [[1, 1, 2], [1, 1, 2], [2, 2, 4]])
  const groups = summarize(records)
  assert.deepEqual([groups[0].tickets, groups[0].pass, groups[0].rework, groups[0].medianMinutes], [3, 2, 1, 1])
  const roster = rosterOutput({ catalog: {}, rules: [], records: groups, workers: [{ id: 'codex', allowed: true, models: [{ id: 'model-a' }] }] })
  assert.equal(roster.workers[0].models[0].record.tickets, 3)
  assert.match(rosterText(roster), /3 tickets, 2 pass\/1 rework\/0 fail/)
  assert.equal(store.stmt('SELECT count(*) AS n FROM conversations').get().n, 1)
})

test('reopening, archived corrections, blocked and model changes stay within their task', t => {
  const { store, c, run } = fixture(t)
  run()
  store.done(c.name, { result: 'pass', why: 'initial' })
  run()
  assert.equal(ticketRecords(store).length, 0)
  assert.equal(store.done(c.name).outcome, 'rework')
  store.stmt('UPDATE conversations SET model=?,thinking=? WHERE id=?').run('model-b', 'low', c.id)
  run(true, 'new model', 'quota exceeded: 429 Too Many Requests')
  store.done(c.name, { result: 'blocked', why: 'quota' })
  store.accept(store.byName(c.name), 'third', 'third', true)
  store.claim(store.byName(c.name))
  const before = store.ticket(c.id)
  const correction = store.done(c.name, { task: 1, result: 'fail', why: 'later found unusable' })
  assert.deepEqual([correction.task, correction.outcome, correction.outcomeReason], [1, 'fail', 'later found unusable'])
  assert.equal(store.ticket(c.id).status, before.status)
  assert.equal(store.ticket(c.id).task, 3)
  assert.equal(store.ticket(c.id).outcome, null)
  assert.equal(store.byName(c.name).status, 'running')
  store.finish(c.id, 4, 'done', 'Review')
  assert.equal(store.done(c.name).outcome, 'pass')
  const records = ticketRecords(store)
  assert.deepEqual(records.map(r => [r.model, r.effort, r.outcome, r.infraFailures]), [
    ['model-a', 'high', 'fail', 0], ['model-b', 'low', 'blocked', 1], ['model-b', 'low', 'pass', 0]
  ])
  assert.equal(summarize(records).find(r => r.model === 'model-b').tickets, 1)
  assert.equal(summarize(records).find(r => r.model === 'model-b').blocked, 1)
  for (const task of [0, -1, 1.2, '1', 99]) assert.throws(() => store.done(c.name, { task, result: 'pass' }), /task number|Unknown task/)
  assert.equal(store.done(c.name, { task: 1 }).outcome, 'fail')
})

test('queued and injected revisions share a task; rejected new tasks cannot mutate the boundary', async t => {
  const { store, c, run } = fixture(t)
  const crew = new Crew(store, { release() {}, reserve() { return false } }, () => ({ allow: ['codex'], worker: 'codex', repoPath: c.cwd }))
  const input = { name: c.name, text: 'next', worker: 'codex', model: c.model, effort: c.thinking, execution: { attachments: [] }, newTask: true }
  store.accept(c, 'first')
  store.claim(store.byName(c.name))
  const refused = await crew.acceptSay(input)
  assert.equal(refused.outcome, 'rejected')
  assert.match(refused.reason, /done before --new-task/)
  assert.equal(store.currentTask(c.id).endTurn, 1)
  assert.equal(store.follow(store.byName(c.name), 'clarify', 'injected', 'delivered').task, 1)
  assert.equal(store.follow(store.byName(c.name), 'revision', 'queued', 'next').task, 1)
  assert.equal(store.currentTask(c.id).endTurn, 2)
  assert.throws(() => store.done(c.name, { result: 'pass' }), /Only tickets in review/)
  store.finish(c.id, 1, 'done', 'Review')
  assert.throws(() => store.done(c.name, { result: 'blocked' }), /Only finished/)
  store.finish(c.id, 2, 'done', 'Review')
  await assert.rejects(crew.acceptSay(input), /done before --new-task/)
  assert.equal(store.tasks(c.id).length, 1)
  store.done(c.name, { result: 'rework', why: 'revision' })
  const receipt = await crew.acceptSay(input)
  assert.deepEqual([receipt.task, receipt.turn], [2, 3])
  assert.equal(store.tasks(c.id)[0].outcome, 'rework')
  store.finish(c.id, 3, 'done', 'Review')
  store.done(c.name, { result: 'pass' })
  run(true)
  assert.deepEqual(store.tasks(c.id).map(t => [t.startTurn, t.endTurn]), [[1, 2], [3, 3], [4, 4]])
})

test('legacy databases migrate once, preserve results and queued ranges, and remain readable', t => {
  const { store, c, path, run } = fixture(t)
  run()
  store.done(c.name, { result: 'pass', why: 'old acceptance' })
  run()
  store.done(c.name, { result: 'rework', why: 'old correction' })
  const pending = store.create('pending', c.cwd, 'm', 'pending', null, 'agy')
  store.accept(pending, 'start')
  store.follow(store.byName('pending'), 'next', 'queued', 'no steer')
  store.db.exec('DROP TABLE tasks')
  const migrated = new Store(false, path)
  try {
    assert.deepEqual(migrated.tasks(c.id).map(t => [t.task, t.startTurn, t.endTurn, t.outcome, t.outcomeReason]), [[1, 1, 2, 'rework', 'old correction']])
    assert.equal(migrated.currentTask(pending.id).endTurn, 2)
    assert.equal(migrated.stmt("SELECT count(*) AS n FROM events WHERE kind='bro.accepted'").get().n, 2)
    assert.equal(ticketRecords(migrated).length, 1)
    migrated.accept(migrated.byName(c.name), 'new', 'new', true)
    migrated.finish(c.id, 3, 'done', 'Review')
    migrated.done(c.name, { result: 'pass', why: 'new acceptance' })
  } finally { migrated.db.close() }
  const reopened = new Store(false, path)
  reopened.db.close()
  const readOnly = new Store(true, path)
  try {
    assert.equal(readOnly.tasks(c.id).length, 2)
    assert.equal(ticketRecords(readOnly).length, 2)
    assert.equal(readOnly.detail(c.name).tasks[0].outcomeReason, 'old correction')
  } finally { readOnly.db.close() }
})

test('shared command definitions describe and parse task boundaries and selectors', () => {
  assert.equal(parseCommand(['say', 'name', 'message', '--new-task']).opt['new-task'], true)
  assert.equal(parseCommand(['done', 'name', '--task', '2', '--result', 'blocked', '--why', 'quota']).opt.task, '2')
  assert.match(commandHelp('say'), /--new-task.*independent task/)
  assert.match(commandHelp('done'), /--task number.*current task/)
})

test('CLI carries task IDs, preserves same-name records, and exposes historical corrections', async t => {
  const h = harness(t)
  await h.json('init', '--allow', 'codex')
  for (let task = 1; task <= 3; task++) {
    const receipt = await h.json('say', 'same', 'work', ...(task > 1 ? ['--new-task'] : []))
    assert.deepEqual([receipt.task, receipt.turn], [task, task])
    await h.json('done', 'same', '--result', 'pass', '--why', 'accepted ' + task)
  }
  const tasks = (await h.json('show', 'same')).tasks
  assert.deepEqual(tasks.map(t => t.outcomeReason), ['accepted 1', 'accepted 2', 'accepted 3'])
  assert.match(await h.cli('show', 'same'), /Task 2 · turns 2–2 · same · pass: accepted 2/)
  assert.equal((await h.json('stats'))[0].tickets, 3)
  assert.equal((await h.json('roster')).workers.find(w => w.id === 'codex').models[0].record.pass, 3)
  await h.json('done', 'same', '--task', '1', '--result', 'fail', '--why', 'unusable')
  assert.deepEqual((await h.json('show', 'same')).tasks.map(t => t.outcome), ['fail', 'pass', 'pass'])
  await h.cli('shutdown')
  assert.equal((await h.json('stats'))[0].fail, 1)
})
