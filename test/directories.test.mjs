import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { parseCommand, commandHelp } from '../lib/cli-args.mjs'
import { Crew } from '../lib/crew.mjs'
import { Store, handoffPrompt } from '../lib/store.mjs'
import { Slots } from '../lib/slots.mjs'
import { repo } from '../lib/paths.mjs'
import { harness, until } from './harness.mjs'

function target(h, name = 'target with spaces') {
  const cwd = join(h.base, name)
  mkdirSync(cwd)
  writeFileSync(join(cwd, 'AGENTS.md'), 'Target instructions')
  writeFileSync(join(h.cwd, 'AGENTS.md'), 'Manager instructions')
  return cwd
}

async function api(h) {
  const url = await h.cli('ui', '--no-open')
  return async (path, data) => {
    const response = await fetch(url + '/api/' + path, {
      method: data ? 'POST' : 'GET', headers: data ? { Origin: url, 'Content-Type': 'application/json' } : undefined,
      body: data ? JSON.stringify(data) : undefined
    })
    const result = await response.json()
    assert.ok(response.ok, JSON.stringify(result))
    return result
  }
}

test('directory flags use the shared parser and help definitions', () => {
  const parsed = parseCommand(['say', 'job', 'task', '--cwd', '../target', '--project', '/manager', '--from', 'old', '--new-task'])
  assert.equal(parsed.opt.cwd, '../target')
  assert.equal(parsed.opt.project, '/manager')
  assert.equal(parsed.opt.from, 'old')
  assert.equal(parsed.opt['new-task'], true)
  const done = parseCommand(['done', 'job', '--project', '/manager', '--task', '1', '--result', 'pass'])
  assert.equal(done.opt.project, '/manager')
  assert.equal(done.opt.task, '1')
  assert.match(commandHelp('say'), /--cwd dir/)
  for (const command of ['say', 'show', 'wait', 'done', 'ls', 'review', 'stop', 'watch', 'roster', 'note']) {
    assert.match(commandHelp(command), /--project path/)
  }
  assert.throws(() => parseCommand(['say', 'job', 'task', '--cwd']), /argument missing/)
  assert.throws(() => parseCommand(['ls', '--project']), /argument missing/)
})

test('directory handoff and new tasks preserve context warnings, source records and cwd binding', async t => {
  const h = harness(t), firstDir = target(h), nextDir = target(h, 'next checkout')
  const store = new Store(false, join(h.base, 'tasks.sqlite'))
  const settings = { repoPath: h.cwd, worker: 'codex', allow: ['codex'], rules: ['Manager rule'] }
  const crew = new Crew(store, { reserve: () => false, release() {} }, () => settings)
  const say = (name, options = {}) => crew.say({ name, text: 'task', model: 'fixture-model', defaultCwd: h.cwd, ...options })
  const finish = (name, reply) => {
    const c = store.byName(name)
    store.finish(c.id, c.turn, 'done', 'Finished', store.assistant(c.id, c.turn, reply))
  }
  try {
    const first = await say('old', { cwd: firstDir, title: 'Original task' })
    assert.deepEqual([first.task, first.turn, first.cwd], [1, 1, firstDir])
    finish('old', 'Original result')
    store.done('old', { result: 'pass', why: 'Accepted first task' })
    store.event(store.byName('old').id, 1, 'usage', { inputTokens: 180000 })
    const second = await say('old', { cwd: firstDir, newTask: true, title: 'Second task' })
    assert.deepEqual([second.task, second.turn, second.cwd, second.contextWarning.inputTokens], [2, 2, firstDir, 180000])
    assert.equal(store.tasks(store.byName('old').id)[0].outcome, 'pass')
    finish('old', 'Second result')
    store.done('old', { result: 'pass', why: 'Accepted second task' })
    const snapshot = () => ['conversations', 'turns', 'messages', 'events', 'tickets', 'tasks', 'collaboration'].map(table =>
      store.stmt('SELECT * FROM ' + table + ' WHERE ' + (table === 'conversations' ? 'id' : 'cid') + '=?').all(store.byName('old').id))
    const before = snapshot()
    const handoff = await say('next', { from: 'old', cwd: nextDir, newTask: true, title: 'Handoff', text: 'Continue here' })
    assert.deepEqual([handoff.task, handoff.turn, handoff.cwd, handoff.contextWarning], [1, 1, nextDir, null])
    assert.deepEqual(handoff.reminders, ['Rule reminder: Manager rule'])
    assert.equal(store.history(store.byName('next').id)[0].content, handoffPrompt('old', 'Second task', firstDir, 'Second result', 'Continue here'))
    assert.equal(crew.workingDirectory(store.byName('next')), nextDir)
    assert.deepEqual(snapshot(), before)
    await assert.rejects(say('bad', { from: 'old', cwd: nextDir, worktree: true }), /--cwd.*--worktree/)
    await assert.rejects(say('old', { cwd: nextDir, newTask: true }), /bound.*directory/)
    await assert.rejects(say('next', { from: 'old', cwd: nextDir }), /new conversation name/)
    assert.deepEqual(snapshot(), before)
    const third = await say('old', { cwd: firstDir, newTask: true })
    assert.equal(third.task, 3)
    store.done('old', { task: 1, result: 'rework', why: 'Correct historical outcome' })
    assert.equal(store.byName('old').status, 'queued')
    assert.deepEqual(store.tasks(store.byName('old').id).map(t => t.outcome), ['rework', 'pass', null])
  } finally { store.db.close() }
})

test('CLI combines project selection with handoff directories and historical task outcomes', async t => {
  const h = harness(t), firstDir = target(h), nextDir = target(h, 'next checkout')
  await h.cli('init', '--allow', 'codex')
  await h.at(nextDir, 'init', '--allow', 'agy')
  await h.at(nextDir, 'say', 'old', 'Other project result')
  const json = async (...args) => JSON.parse(await h.at(nextDir, ...args, '--project', h.cwd, '--json'))
  await json('say', 'old', 'context tokens 180000', '--cwd', firstDir)
  await json('done', 'old', '--task', '1', '--result', 'pass')
  const second = await json('say', 'old', 'hold', '--cwd', firstDir, '--new-task', '--bg')
  assert.deepEqual([second.task, second.turn, second.cwd, second.contextWarning.inputTokens], [2, 2, firstDir, 180000])
  await json('done', 'old', '--task', '1', '--result', 'rework', '--why', 'Historical correction')
  assert.equal((await json('show', 'old')).tasks[0].outcome, 'rework')
  await json('say', 'old', 'finish')
  await json('done', 'old', '--task', '2', '--result', 'pass')
  const source = await json('show', 'old')
  const handoff = await json('say', 'next', 'Continue here', '--from', 'old', '--cwd', '.', '--new-task')
  assert.deepEqual([handoff.cwd, handoff.task, handoff.turn], [nextDir, 1, 1])
  assert.equal(handoff.reply, handoffPrompt('old', source.title, firstDir, source.reply, 'Continue here'))
  assert.notEqual((await json('show', 'next')).session, source.session)
  await json('done', 'next', '--task', '1', '--result', 'pass')
  assert.deepEqual((await json('show', 'old')).tasks, source.tasks)
  assert.equal(JSON.parse(await h.at(nextDir, 'show', 'old', '--json')).reply, 'Other project result')
  assert.equal(JSON.parse(await h.at(nextDir, 'ls', '--json'))[0].status, 'review')
})

test('directory core preserves explicit paths, checks errors and reviews the external checkout', async t => {
  const h = harness(t), cwd = target(h), path = join(h.base, 'tickets.sqlite')
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' })
  git('init', '-q')
  git('add', 'AGENTS.md')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-qm', 'Seed')
  const settings = { repoPath: h.cwd, worker: 'codex', allow: ['codex', 'agy'], rules: ['Manager rule'] }
  const slots = new Slots(1)
  slots.paused = true
  let store = new Store(false, path)
  let crew = new Crew(store, slots, () => settings)
  const say = (name, options = {}) => crew.say({ name, text: 'task', model: 'fixture-model', defaultCwd: settings.repoPath, ...options })
  try {
    for (const [options, error] of [
      [{ cwd: join(h.base, 'missing') }, /--cwd.*does not exist/],
      [{ cwd: join(cwd, 'AGENTS.md') }, /--cwd.*directory/],
      [{ cwd: '' }, /--cwd.*empty/],
      [{ cwd, worktree: true }, /--cwd.*--worktree/],
      [{ cwd, worker: 'cursor-agent' }, /not allowed/]
    ]) await assert.rejects(say('bad', options), error)
    assert.equal(store.byName('bad'), undefined)
    const receipt = await say('writer', { cwd })
    assert.equal(receipt.cwd, cwd)
    assert.deepEqual(receipt.reminders, ['Rule reminder: Manager rule'])
    assert.equal((await say('writer', { cwd: h.cwd })).outcome, 'rejected')
    const link = join(h.base, 'alias')
    symlinkSync(cwd, link, process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal((await say('writer', { cwd: link })).outcome, 'queued')
    store.db.close()
    store = new Store(false, path)
    crew = new Crew(store, slots, () => settings)
    const contexts = []
    crew.runNative = async (c, text, controller, ready) => {
      contexts.push({ cwd: c.cwd, text })
      ready.resolve(null)
      if (c.name === 'writer') writeFileSync(join(c.cwd, 'proof.txt'), 'proof')
      store.finish(c.id, c.turn, 'done', 'Finished', store.assistant(c.id, c.turn, 'fixture reply'))
    }
    await crew.startTurn(store.byName('writer'))
    assert.equal(contexts[0].cwd, cwd)
    assert.deepEqual(store.ticket(store.byName('writer').id).changedFiles, [{ path: 'proof.txt', status: 'A' }])
    await crew.startTurn(store.byName('writer'))
    const review = await crew.review({ name: 'writer', by: 'agy', model: 'fixture-model' })
    await crew.startTurn(store.byName(review.name))
    assert.equal(contexts.at(-1).cwd, cwd)
    assert.match(contexts.at(-1).text, /A "proof.txt"/)
    await assert.rejects(say('writer', { cwd: h.cwd }), /bound.*directory/)
    await assert.rejects(say('writer', { worktree: true }), /worktree/)
    const ordinary = await say('ordinary')
    settings.repoPath = join(h.base, 'moved-manager')
    mkdirSync(settings.repoPath)
    assert.equal(crew.workingDirectory(store.byName('ordinary')), settings.repoPath)
    assert.equal(crew.workingDirectory(store.byName('writer')), cwd)
    assert.equal(ordinary.cwd, h.cwd)
    store.stmt('UPDATE collaboration SET worktree=? WHERE cid=?').run(cwd, store.byName('ordinary').id)
    assert.match((await say('ordinary', { cwd: h.cwd })).reason, /--cwd.*worktree/)
    await say('lost', { cwd })
    rmSync(cwd, { recursive: true })
    crew.release = async () => false
    await assert.rejects(crew.startTurn(store.byName('lost')), /directory.*does not exist/)
    assert.equal(store.result(store.byName('lost').id, 1).status, 'error')
    await say('revoked', { cwd: h.cwd })
    settings.allow = []
    await assert.rejects(crew.startTurn(store.byName('revoked')), /no longer allowed/)
  } finally { store.db.close() }
})

for (const provider of ['codex', 'codex-exec', 'agy', 'cursor-agent', 'custom:fixture']) {
  test(provider + ' directory adapter launches and resumes without a runner', async t => {
    const h = harness(t), cwd = target(h)
    if (provider === 'codex-exec') writeFileSync(join(cwd, 'exec-only'), '')
    const script = [
      "import { nativeTurn } from './lib/native.mjs'",
      "import { streamTurn } from './lib/stream-workers.mjs'",
      'const input = JSON.parse(process.argv[1])',
      "const ctx = { ...input, text: 'working directory', name: 'probe', model: 'fixture-model', signal: new AbortController().signal, owner() {}, ready() {}, event() {} }",
      'let session = input.session, transport = input.transport',
      'ctx.bind = (id, kind) => { if (session && session !== id) throw new Error("Session changed"); session = id; transport = kind }',
      "const reply = await (ctx.provider === 'codex' ? nativeTurn : streamTurn)(ctx)",
      'console.log(JSON.stringify({ reply, session, transport }))'
    ].join('\n')
    let saved = {}
    for (let turn = 0; turn < 2; turn++) {
      const input = { provider: provider === 'codex-exec' ? 'codex' : provider, cwd, marker: join(h.base, 'marker'),
        session: saved.session, transport: saved.transport,
        template: { command: 'template-cli', newArgs: ['--prompt', '{prompt}', '--cwd', '{cwd}'],
          resumeArgs: ['--resume', '{session}', '--prompt', '{prompt}', '--cwd', '{cwd}'], modelArgs: ['--model', '{model}'],
          format: 'json', reply: { path: 'reply' }, session: { path: 'id' } } }
      const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(input)], {
        cwd: repo, env: h.env, timeout: 15000
      })
      saved = JSON.parse(stdout)
      const reply = JSON.parse(saved.reply)
      assert.equal(reply.cwd, cwd)
      assert.equal(reply.instructions, 'Target instructions')
      if (provider === 'custom:fixture') assert.equal(reply.args[reply.args.indexOf('--cwd') + 1], cwd)
      if (provider === 'codex-exec') assert.equal(saved.transport, 'exec')
    }
  })
}

for (const worker of ['codex', 'codex-exec', 'pi:deepseek', 'agy', 'cursor-agent', 'custom:fixture']) {
  test(worker + ' starts and resumes in the requested directory with manager policy', async t => {
    const h = harness(t), cwd = target(h)
    const provider = worker === 'codex-exec' ? 'codex' : worker
    const project = await h.json('init', '--allow', provider.startsWith('custom:') ? 'codex' : provider)
    const web = await api(h)
    const config = await web('settings/' + project.id)
    config.rules = ['Manager rule']
    if (provider.startsWith('custom:')) {
      const template = { command: 'template-cli', newArgs: ['--prompt', '{prompt}', '--directory', '{cwd}'],
        resumeArgs: ['--resume', '{session}', '--prompt', '{prompt}', '--directory', '{cwd}'],
        format: 'json', reply: { path: 'reply' }, session: { path: 'id' } }
      await web('templates/' + project.id + '/test', { template })
      config.entries = { [provider]: { template } }
      config.allow = ['codex', provider]
    }
    await web('settings/' + project.id, config)
    if (worker === 'codex-exec') writeFileSync(join(cwd, 'exec-only'), '')
    const first = await h.json('say', 'job', 'working directory', '--worker', provider, '--cwd', relative(h.cwd, cwd))
    assert.deepEqual(first.reminders, ['Rule reminder: Manager rule'])
    const check = result => {
      const reply = JSON.parse(result.reply)
      assert.equal(reply.cwd, cwd)
      assert.equal(reply.instructions, 'Target instructions')
      if (provider.startsWith('custom:')) assert.equal(reply.args.at(-1), cwd)
    }
    check(first)
    const original = await h.json('show', 'job')
    assert.equal(original.cwd, cwd)
    if (worker === 'codex-exec') assert.equal(original.transport, 'exec')
    assert.equal(existsSync(join(cwd, '.broco')), false)
    await h.cli('shutdown')
    check(await h.json('say', 'job', 'working directory'))
    const link = join(h.base, 'target-link')
    symlinkSync(cwd, link, process.platform === 'win32' ? 'junction' : 'dir')
    check(await h.json('say', 'job', 'working directory', '--cwd', link))
    assert.equal((await h.json('show', 'job')).session, original.session)
  })
}

test('explicit project manages identically named tickets from unrelated and registered directories', async t => {
  const h = harness(t), cwd = target(h)
  const manager = await h.json('init', '--allow', 'codex')
  await h.at(cwd, 'init', '--allow', 'agy')
  await h.at(cwd, 'say', 'same', 'target ticket')
  await h.at(cwd, 'say', 'same', 'manager ticket', '--project', h.cwd, '--cwd', '.')
  const outside = join(h.base, 'outside'), nested = join(h.cwd, 'subdirectory')
  mkdirSync(outside)
  mkdirSync(nested)
  for (const from of [cwd, outside]) {
    const project = relative(from, nested)
    assert.equal(JSON.parse(await h.at(from, 'show', 'same', '--project', project, '--json')).reply, 'manager ticket')
    assert.equal(await h.at(from, 'wait', 'same', '1', '--project', project), 'manager ticket')
    assert.deepEqual(JSON.parse(await h.at(from, 'ls', '--project', project, '--json')).map(t => t.id), ['same'])
  }
  await h.at(outside, 'done', 'same', '--project', h.cwd)
  assert.equal((await h.json('ls'))[0].status, 'done')
  assert.equal(JSON.parse(await h.at(cwd, 'show', 'same', '--json')).reply, 'target ticket')
  assert.equal(JSON.parse(await h.at(cwd, 'ls', '--json'))[0].status, 'review')
  await assert.rejects(h.cli('say', 'denied', 'task', '--cwd', cwd, '--worker', 'agy'), /not allowed in this project/)
  assert.equal((await h.json('init')).id, manager.id)
  await assert.rejects(h.at(outside, 'ls', '--project', outside), /not registered/)
  await assert.rejects(h.cli('ls', '--project', join(outside, 'missing')), /--project.*directory|--project.*exist/)
})

test('invalid directories, worktree conflicts and attempts to relocate a session fail explicitly', async t => {
  const h = harness(t), cwd = target(h)
  await h.cli('init', '--allow', 'codex')
  for (const [args, error] of [
    [['--cwd', join(h.base, 'missing')], /--cwd.*does not exist/],
    [['--cwd', join(cwd, 'AGENTS.md')], /--cwd.*directory/],
    [['--cwd', ''], /--cwd.*empty/],
    [['--cwd', cwd, '--worktree'], /--cwd.*--worktree/]
  ]) await assert.rejects(h.cli('say', 'bad', 'task', ...args), error)
  assert.deepEqual(await h.json('ls'), [])
  await assert.rejects(h.cli('ls', '--project', ''), /--project.*empty/)
  await assert.rejects(h.cli('ls', '--project', join(cwd, 'AGENTS.md')), /--project.*directory/)
  await h.cli('say', 'job', 'hello', '--cwd', cwd)
  await assert.rejects(h.cli('say', 'job', 'move', '--cwd', h.cwd), /bound.*directory/)
  await assert.rejects(h.cli('say', 'job', 'tree', '--worktree'), /worktree/)
  await h.cli('say', 'job', 'hold', '--bg')
  await assert.rejects(h.json('say', 'job', 'move', '--cwd', h.cwd, '--bg'), err => {
    const receipt = JSON.parse(err.stdout)
    assert.equal(receipt.outcome, 'rejected')
    assert.match(receipt.reason, /bound.*directory/)
    return true
  })
  await h.cli('stop', 'job')
  rmSync(cwd, { recursive: true })
  await assert.rejects(h.cli('say', 'job', 'lost directory'), /directory.*does not exist/)
})

test('external checkout changes and linked review use the writer directory', async t => {
  const h = harness(t), cwd = target(h)
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('add', 'AGENTS.md')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-qm', 'Seed')
  await h.cli('init', '--allow', 'codex,pi:deepseek', '--default-worker', 'codex')
  await h.cli('say', 'writer', 'write fixture', '--cwd', cwd)
  const writer = await h.json('show', 'writer')
  assert.ok(writer.changedFiles.some(f => f.path === 'proof file.txt' && f.status === 'A'))
  assert.equal(readFileSync(join(cwd, 'proof file.txt'), 'utf8'), 'proof')
  assert.equal(existsSync(join(h.cwd, 'proof file.txt')), false)
  const review = await h.json('review', 'writer', '--by', 'pi:deepseek', '--project', h.cwd)
  assert.match(review.reply, /A "proof file.txt"/)
  assert.equal((await h.json('show', review.name)).cwd, cwd)
  assert.equal(JSON.parse((await h.json('say', review.name, 'working directory')).reply).cwd, cwd)
})

test('queued directories survive recovery and disappearances fail before worker launch', async t => {
  const h = harness(t, false, { BROCO_CONCURRENCY: '1' }), cwd = target(h)
  await h.cli('init', '--allow', 'codex')
  await h.cli('say', 'busy', 'hold', '--bg')
  await h.cli('say', 'queued', 'working directory', '--cwd', cwd, '--bg')
  process.kill(await h.runnerPid(), 'SIGKILL')
  assert.equal(JSON.parse((await h.json('wait', 'queued', '1')).reply).cwd, cwd)
  await h.cli('say', 'busy', 'hold', '--bg')
  await h.cli('say', 'lost', 'working directory', '--cwd', cwd, '--bg')
  renameSync(cwd, cwd + '-moved')
  await h.cli('stop', 'busy')
  await assert.rejects(h.cli('wait', 'lost', '1'), /directory.*does not exist/)
  await until(async () => (await h.json('show', 'lost')).status === 'error')
  assert.equal((await h.json('show', 'lost')).session, null)
})
