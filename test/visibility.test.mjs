import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { classify, hint } from '../lib/problems.mjs'
import { codexQuota, quotaText, tight } from '../lib/quota.mjs'
import { Roster } from '../lib/roster.mjs'
import { Store, handoffPrompt } from '../lib/store.mjs'
import { Crew } from '../lib/crew.mjs'
import { ticketRecords } from '../lib/stats.mjs'
import { harness } from './harness.mjs'

test('context warning uses the latest input measurement, carries across turns, and clears after compaction', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-bro-context-'))
  const store = new Store(false, join(dir, 'tickets.sqlite'))
  try {
    const c = store.create('long', dir, 'm', 'Long task', null, 'codex')
    store.accept(c, 'first')
    assert.equal(store.contextWarning(c.id, 1), null)
    for (const inputTokens of [null, -1, '180000', 149999, 150000]) {
      store.event(c.id, 1, 'usage', { inputTokens }, '')
      assert.equal(store.result(c.id, 1).contextWarning, null)
    }
    store.event(c.id, 1, 'usage', { inputTokens: 150001 }, '')
    const activeWarning = store.result(c.id, 1).contextWarning
    assert.equal(activeWarning.actionable, false)
    assert.match(activeWarning.message, /上下文已达阈值（运行中暂不切换）/)
    store.finish(c.id, 1, 'done', 'Finished')
    const warning = store.result(c.id, 1).contextWarning
    assert.deepEqual([warning.inputTokens, warning.threshold, warning.turn, warning.actionable], [150001, 150000, 1, true])
    assert.match(warning.message, /该换新名字了/)
    assert.deepEqual(store.contextWarning(c.id, 2), warning)
    store.event(c.id, 2, 'usage', { inputTokens: 1000 }, '')
    assert.equal(store.contextWarning(c.id, 2), null)
    assert.deepEqual(store.contextWarning(c.id, 1), warning)
    const argon = store.create('argon', dir, 'gemini-4-argon', '1M model', null, 'agy')
    store.accept(argon, 'first')
    store.event(argon.id, 1, 'usage', { inputTokens: 200000 }, '')
    store.finish(argon.id, 1, 'done', 'Finished')
    assert.equal(store.contextWarning(argon.id, 1), null)
    store.event(argon.id, 1, 'usage', { inputTokens: 629146 }, '')
    const argonWarning = store.contextWarning(argon.id, 1)
    assert.equal(argonWarning.threshold, 629145)
    assert.equal(argonWarning.actionable, true)
  } finally { store.db.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('handoff dispatch preserves source rows and records and only copies the last completed reply', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-bro-handoff-'))
  const store = new Store(false, join(dir, 'tickets.sqlite'))
  try {
    const c = store.create('old', dir, 'fixture-model', 'Protocol repair', 'medium', 'codex')
    store.accept(c, 'Original task with long history')
    store.message(c.id, 1, 'reply', 'Obsolete reply')
    store.finish(c.id, 1, 'done', 'Finished')
    store.accept(store.byName('old'), 'Fix framing')
    store.message(c.id, 2, 'reply', 'Fixed framing.\nSee docs/status.md.')
    store.event(c.id, 2, 'usage', { inputTokens: 180000 }, '')
    store.finish(c.id, 2, 'done', 'Finished')
    store.accept(store.byName('old'), 'Failed attempt')
    store.message(c.id, 3, 'text', 'Partial reply must not be copied')
    store.finish(c.id, 3, 'error', 'Provider unavailable')
    store.stmt("UPDATE tickets SET stage='done',outcome='blocked',outcome_reason='Provider unavailable' WHERE cid=?").run(c.id)
    const snapshot = () => ['conversations', 'turns', 'messages', 'events', 'tickets', 'collaboration'].map(table =>
      store.stmt('SELECT * FROM ' + table + ' WHERE ' + (table === 'conversations' ? 'id' : 'cid') + '=?').all(c.id))
    const before = snapshot(), record = ticketRecords(store)
    const crew = new Crew(store, { reserve: () => false, release: () => {} }, () => ({
      worker: 'codex', allow: ['codex'], repoPath: dir, entries: { codex: { model: 'fixture-model' } }
    }))
    const text = 'Add retries.\nRead docs/status.md.'
    const receipt = await crew.say({ name: 'new', from: 'old', text, defaultCwd: dir })
    assert.equal(receipt.turn, 1)
    assert.equal(receipt.contextWarning, null)
    const fresh = store.byName('new')
    assert.notEqual(fresh.id, c.id)
    assert.equal(fresh.native_id, null)
    assert.equal(store.meta(fresh.id).parent, null)
    assert.equal(store.ticket(fresh.id).outcome, null)
    assert.equal(store.history(fresh.id)[0].content, handoffPrompt('old', 'Protocol repair', dir, 'Fixed framing.\nSee docs/status.md.', text))
    assert.deepEqual(snapshot(), before)
    assert.deepEqual(ticketRecords(store), record)
    await assert.rejects(crew.say({ name: 'old', from: 'old', text, defaultCwd: dir }), /requires a new conversation name/)
    await assert.rejects(crew.say({ name: 'new', from: 'old', text, defaultCwd: dir }), /requires a new conversation name/)
    await assert.rejects(crew.say({ name: 'missing', from: 'missing', text, defaultCwd: dir }), /Unknown handoff source/)
    await assert.rejects(crew.say({ name: 'early', from: 'new', text, defaultCwd: dir }), /inactive source/)
    await assert.rejects(crew.say({ name: 'empty', from: 'old', text: ' ', defaultCwd: dir }), /Message is empty/)
    assert.deepEqual(snapshot(), before)
    const again = await crew.say({ name: 'old', text: 'next', defaultCwd: dir })
    assert.equal(again.contextWarning.inputTokens, 180000)
    assert.equal(again.name, 'old')
    store.finish(fresh.id, 1, 'stopped', 'Stopped')
    assert.match(store.handoff('new', 'next'), /\(It never completed a reply\.\)/)
  } finally { store.db.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('say receipts, wait and show warn about long context without switching sessions', async t => {
  const h = harness(t)
  await h.json('init', '--allow', 'codex')
  await h.cli('say', 'long', 'context tokens 150000')
  assert.equal((await h.json('show', 'long')).contextWarning, null)
  assert.match(await h.cli('say', 'long', 'context tokens 150001'), /该换新名字了/)
  const shown = await h.json('show', 'long')
  assert.equal(shown.contextWarning.inputTokens, 150001)
  assert.match(await h.cli('show', 'long'), /该换新名字了/)
  assert.match(await h.cli('wait', 'long', '2'), /该换新名字了/)
  assert.deepEqual((await h.json('wait', 'long', '2')).contextWarning, shown.contextWarning)
  const receipt = await h.json('say', 'long', 'hold', '--bg')
  assert.deepEqual(receipt.contextWarning, shown.contextWarning)
  assert.equal((await h.json('show', 'long')).session, shown.session)
  const inFlightWarning = (await h.json('show', 'long')).contextWarning
  assert.equal(inFlightWarning.actionable, false)
  assert.match(inFlightWarning.message, /上下文已达阈值（运行中暂不切换）.*wait for current turn to finish before using --from long/)
  assert.match(await h.cli('say', 'long', 'more work', '--bg'), /上下文已达阈值（运行中暂不切换）/)
  await h.cli('stop', 'long')
  await h.cli('say', 'long', 'short again')
  assert.equal((await h.json('show', 'long')).contextWarning, null)
  assert.equal((await h.json('ls')).length, 1)
})

test('handoff creates a fresh session with title, final reply and manager instructions without changing the source or record', async t => {
  const h = harness(t)
  await h.json('init', '--allow', 'codex')
  await h.cli('say', 'old', 'obsolete reply', '--title', 'Protocol repair')
  await h.cli('say', 'old', 'Fixed framing.\nTests passed; see docs/status.md.')
  await h.cli('done', 'old', '--result', 'rework', '--why', 'Accepted after revision')
  const old = await h.json('show', 'old')
  const record = await h.json('stats')
  const snapshot = () => ['conversations', 'turns', 'messages', 'events', 'tickets', 'collaboration'].map(table =>
    h.query('SELECT * FROM ' + table + ' WHERE ' + (table === 'conversations' ? 'id' : 'cid') + '=(SELECT id FROM conversations WHERE name=?)', 'old'))
  const before = snapshot()
  const instructions = 'Continue with retries.\nRead docs/status.md before editing.'
  const expected = handoffPrompt('old', 'Protocol repair', h.cwd, 'Fixed framing.\nTests passed; see docs/status.md.', instructions)
  const fresh = await h.json('say', 'new', instructions, '--from', 'old', '--title', 'Retries')
  assert.equal(fresh.reply, expected)
  assert.equal(fresh.turn, 1)
  const shown = await h.json('show', 'new')
  assert.notEqual(shown.session, old.session)
  assert.equal(shown.title, 'Retries')
  assert.equal(shown.parent, null)
  assert.equal(shown.outcome, null)
  assert.deepEqual(snapshot(), before)
  assert.deepEqual(await h.json('stats'), record)
  await assert.rejects(h.cli('say', 'old', 'again', '--from', 'old'), /requires a new conversation name/)
  await assert.rejects(h.cli('say', 'new', 'again', '--from', 'old'), /requires a new conversation name/)
  await assert.rejects(h.cli('say', 'missing', 'again', '--from', 'unknown'), /Unknown handoff source/)
  await assert.rejects(h.cli('say', 'empty', ' ', '--from', 'old'), /Message is empty/)
  assert.deepEqual(snapshot(), before)
  await h.cli('say', 'busy', 'hold', '--bg')
  await assert.rejects(h.cli('say', 'early', 'again', '--from', 'busy'), /inactive source/)
  await h.cli('stop', 'busy')
  assert.match((await h.json('say', 'no-reply', 'next', '--from', 'busy')).reply, /\(It never completed a reply\.\)/)
  await assert.rejects(h.cli('say', 'old', 'policy fail'))
  assert.equal((await h.json('say', 'after-error', instructions, '--from', 'old')).reply, expected)
  assert.match(await h.cli('say', '--help'), /--from name/)
})

test('failure text from each worker maps to an actionable class', () => {
  const cases = {
    region: 'agy exited with status 3: error: FAILED_PRECONDITION (code 400): User location is not supported for the API use.',
    policy: 'This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request.',
    quota: '429 Too Many Requests: insufficient balance',
    auth: 'Request failed: 401 Unauthorized',
    context: 'prompt is too long: 250000 tokens > 200000 maximum',
    network: 'fetch failed: ECONNRESET',
    'worker ': 'billing address is invalid; disk quota exceeded; at handler (app.js:429:12); assert.equal(res.code, 401)',
    worker: 'pi settled without an assistant message'
  }
  for (const [cls, message] of Object.entries(cases)) assert.equal(classify(message).class, cls.trim(), message)
  assert.equal(classify('HTTP 429: slow down').class, 'quota')
  assert.equal(classify('request failed with status code 503').class, 'network')
  assert.equal(classify('anything', { codex: 'usageLimitExceeded' }).class, 'quota')
  assert.equal(classify('anything', { codex: { httpConnectionFailed: { httpStatusCode: 502 } } }).class, 'network')
  assert.equal(hint(classify('x')), null)
  assert.match(hint(classify('x', { codex: 'usageLimitExceeded', resetsAt: 1795000000 })), /额度用尽，.*重置/)
})

test('quota snapshots normalize windows and flag tight budgets', () => {
  const q = codexQuota({ planType: 'prolite', primary: { usedPercent: 97, windowDurationMins: 10080, resetsAt: 1794666185 }, secondary: null })
  assert.deepEqual(q.windows, [{ minutes: 10080, usedPercent: 97, resetsAt: new Date(1794666185000).toISOString() }])
  assert.ok(tight(q))
  assert.match(quotaText(q), /^quota=week 97% used \(resets .+\) · 先别派/)
  assert.ok(!tight(codexQuota({ primary: { usedPercent: 10, windowDurationMins: 300 } })))
  assert.ok(tight(codexQuota({ primary: { usedPercent: 10, windowDurationMins: 300 } }, false)))
  assert.equal(quotaText(null), 'quota=unknown')
})

test('codex quota is read, spent per turn, and exhaustion ends the turn with a class', async t => {
  const h = harness(t)
  await h.json('init', '--allow', 'codex')
  const roster = await h.json('roster')
  const codex = roster.workers.find(w => w.id === 'codex')
  assert.deepEqual(codex.quota.windows.map(w => [w.minutes, w.usedPercent]), [[300, 40], [10080, 70]])
  assert.match(await h.cli('roster'), /quota=5h 40% used .* · week 70% used/)

  await h.cli('say', 'spend', 'spend quota')
  const spent = await h.json('show', 'spend')
  assert.deepEqual(spent.quota.spent, [{ minutes: 300, percent: 3 }, { minutes: 10080, percent: 1 }])
  assert.match(await h.cli('show', 'spend'), /Quota spent this turn: 5h 3% · week 1%/)

  await assert.rejects(h.cli('say', 'broke', 'quota fail'), /Problem: quota · 额度用尽/)
  const broke = await h.json('show', 'broke')
  assert.equal(broke.status, 'error')
  assert.equal(broke.problem.class, 'quota')
  assert.equal(broke.problem.resetsAt, new Date(1795000000000).toISOString())
  assert.match(await h.cli('ls'), /broke\tbroke\tworking\terror\/quota/)

  assert.equal(await h.cli('say', 'patient', 'rate retry'), 'rate retry')
  assert.equal((await h.json('show', 'patient')).problem, null)

  await assert.rejects(h.cli('say', 'filtered', 'policy fail'), /Problem: policy/)
  assert.equal((await h.json('show', 'filtered')).problem.class, 'policy')
  assert.equal(await h.cli('say', 'filtered', 'rephrased'), 'rephrased')
  assert.equal((await h.json('show', 'filtered')).problem, null)
  assert.equal((await h.json('done', 'filtered')).outcome, 'pass')
  await h.cli('say', 'filtered', 'reopened')
  assert.equal((await h.json('show', 'filtered')).outcome, null)
})

test('roster surfaces recent quota and region failures for bros without a quota API', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-bro-observe-'))
  try {
    const store = new Store(false, join(dir, 'tickets.sqlite'))
    const fail = (name, provider, message) => {
      const c = store.create(name, dir, 'm', name, null, provider)
      store.accept(c, 'x')
      store.finish(c.id, 1, 'error', message)
    }
    fail('a', 'agy', 'User location is not supported for the API use.')
    fail('b', 'pi:deepseek', 'Insufficient Balance')
    fail('c', 'cursor-agent', 'pi settled without an assistant message')
    fail('d', 'agy', 'pi settled without an assistant message')
    fail('e', 'pi:openai', 'Insufficient Balance')
    const ok = store.create('f', dir, 'm', 'f', null, 'pi:openai')
    store.accept(ok, 'x')
    store.finish(ok.id, 1, 'done', 'Waiting for manager')
    const rows = [{ id: 'codex', quota: codexQuota({ primary: { usedPercent: 5, windowDurationMins: 300 } }) }, { id: 'pi:openai-codex' }, { id: 'agy' }, { id: 'pi:deepseek' }, { id: 'cursor-agent' }, { id: 'pi:openai' }]
    Roster.prototype.observe.call({ projects: { crews: () => [{ store }] } }, rows)
    assert.equal(rows[1].quota.sharedWith, 'codex')
    assert.equal(rows[2].recentProblem.class, 'region')
    assert.equal(rows[3].quota.source, 'observed')
    assert.match(quotaText(rows[3].quota), /observed: quota .* 先别派/)
    assert.equal(rows[4].quota, undefined)
    assert.equal(rows[4].recentProblem, undefined)
    assert.equal(rows[5].quota, undefined, 'a later finished turn clears the warning')
    store.db.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('acceptance records outcomes; stats and roster show your own record once the sample is big enough', async t => {
  const h = harness(t)
  await h.json('init', '--allow', 'codex')
  await h.cli('say', 'one', 'first')
  assert.match(await h.cli('done', 'one'), /one accepted · pass \(inferred/)
  await h.cli('say', 'two', 'first')
  await h.cli('say', 'two', 'again')
  assert.equal((await h.json('done', 'two')).outcome, 'rework')
  await assert.rejects(h.cli('say', 'three', 'quota fail'))
  await assert.rejects(h.cli('done', 'three'), /use --result fail/)
  const closed = await h.json('done', 'three', '--result', 'fail', '--why', 'quota ran out')
  assert.deepEqual([closed.status, closed.outcome, closed.outcomeReason], ['done', 'fail', 'quota ran out'])
  await assert.rejects(h.cli('done', 'one', '--result', 'maybe'), /Expected --result/)
  assert.equal((await h.json('done', 'one', '--result', 'rework', '--why', 'missed a test')).outcome, 'rework')
  await h.cli('say', 'four', 'wrong approach')
  await h.cli('done', 'four', '--result', 'fail', '--why', 'unusable')
  await h.cli('say', 'five', 'hold', '--bg')
  await h.cli('stop', 'five')
  assert.equal((await h.json('done', 'five', '--result', 'blocked', '--why', 'switched bro')).outcome, 'blocked')

  const stats = await h.json('stats')
  assert.equal(stats.length, 1)
  assert.deepEqual([stats[0].worker, stats[0].model, stats[0].role, stats[0].tickets, stats[0].pass, stats[0].rework, stats[0].fail, stats[0].infraFailures], ['codex', 'fixture-model', 'write', 3, 0, 2, 1, 1])
  assert.equal(stats[0].blocked, 2)
  assert.match(await h.cli('stats'), /codex\tfixture-model\twrite\t3\t0\t2\t1\t2/)
  const model = (await h.json('roster')).workers.find(w => w.id === 'codex').models[0]
  assert.deepEqual([model.record.tickets, model.record.rework, model.record.fail], [3, 2, 1])
  assert.match(await h.cli('roster'), /fixture-model .* yours: 3 tickets, 0 pass\/2 rework\/1 fail/)
})

test('upgrading a database classifies failures recorded before 0.4', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-bro-upgrade-'))
  try {
    const path = join(dir, 'tickets.sqlite')
    let store = new Store(false, path)
    const c = store.create('old', dir, 'm', 'old', null, 'agy')
    store.accept(c, 'x')
    store.finish(c.id, 1, 'error', 'User location is not supported for the API use.')
    store.db.exec('ALTER TABLE turns DROP COLUMN problem')
    store.db.close()
    store = new Store(false, path)
    assert.equal(store.problem(c.id, 1).class, 'region')
    store.db.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
