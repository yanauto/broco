import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { START_MARKER, END_MARKER, claudeMdBlock, ensureClaudeMd, removeClaudeMd } from '../lib/claude-md.mjs'
import { formatDateTime, formatShortTime, resolvedTimeZone } from '../lib/time.mjs'
import { legacyCcBroHome, repo } from '../lib/paths.mjs'
import { harness } from './harness.mjs'

test('AGENTS.md / CLAUDE.md init helper creates, appends without touching existing text, updates, and removes cleanly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'broco-claude-md-'))
  try {
    const first = ensureClaudeMd(dir)
    assert.equal(first.action, 'created')
    assert.equal(first.file, 'AGENTS.md')
    const created = readFileSync(first.path, 'utf8')
    assert.ok(created.startsWith(START_MARKER))
    assert.ok(created.trimEnd().endsWith(END_MARKER))
    assert.match(created, /On-Demand Crew/)
    assert.match(created, /broco roster --json/)
    assert.match(created, /broco map/)
    assert.match(created, /broco review/)
    assert.match(created, /broco done/)
    assert.match(claudeMdBlock({ managerMode: true }), /manager/)

    assert.equal(ensureClaudeMd(dir).action, 'unchanged')

    const del = removeClaudeMd(dir)
    assert.equal(del.action, 'deleted')
    assert.equal(existsSync(first.path), false)
    assert.equal(removeClaudeMd(dir).action, 'absent')

    const userContent = '# Team Guide\n\nKeep commits atomic.\nNever hardcode secrets.'
    writeFileSync(first.path, userContent)
    const appended = ensureClaudeMd(dir)
    assert.equal(appended.action, 'appended')
    const withAppended = readFileSync(first.path, 'utf8')
    assert.equal(withAppended.slice(0, userContent.length), userContent)
    assert.ok(withAppended.startsWith(userContent + '\n\n' + START_MARKER))

    const tampered = withAppended.replace('broco map', 'outdated command') + '\n\n## Footer\nStay sharp.\n'
    writeFileSync(first.path, tampered)
    const updated = ensureClaudeMd(dir)
    assert.equal(updated.action, 'updated')
    const withUpdated = readFileSync(first.path, 'utf8')
    assert.ok(withUpdated.includes(claudeMdBlock()))
    assert.ok(withUpdated.startsWith(userContent + '\n\n' + START_MARKER))
    assert.ok(withUpdated.endsWith('\n\n## Footer\nStay sharp.\n'))

    const stripped = removeClaudeMd(dir)
    assert.equal(stripped.action, 'stripped')
    const remaining = readFileSync(first.path, 'utf8')
    assert.equal(remaining.includes(START_MARKER), false)
    assert.match(remaining, /# Team Guide/)
    assert.match(remaining, /## Footer/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fast Roster.list skips detectCli subprocesses for disallowed workers and warns on unlisted default models', t => {
  const h = harness(t)
  mkdirSync(h.data, { recursive: true })
  const fakeBin = join(h.base, 'fake-bin')
  const canaryDir = join(h.base, 'canaries')
  mkdirSync(fakeBin, { recursive: true })
  mkdirSync(canaryDir, { recursive: true })
  for (const name of ['claude', 'agy', 'cursor-agent']) {
    const script = join(fakeBin, name)
    writeFileSync(script, '#!/usr/bin/env node\nimport { writeFileSync } from "node:fs"\nwriteFileSync(' + JSON.stringify(join(canaryDir, name)) + ', "spawned")\nprocess.exit(1)\n')
    chmodSync(script, 0o755)
  }
  writeFileSync(join(h.cwd, 'fixture-models.json'), JSON.stringify([
    { model: 'gpt-6-astra', inputModalities: ['text', 'image'] }
  ]))
  const script = `
    import assert from 'node:assert/strict'
    import { existsSync } from 'node:fs'
    import { join } from 'node:path'
    import { DatabaseSync } from 'node:sqlite'
    import { Roster } from './lib/roster.mjs'
    import { rosterOutput } from './lib/roster-output.mjs'

    const cwd = process.argv[1]
    const canaryDir = process.argv[2]
    const db = new DatabaseSync(':memory:')
    const project = { id: 'p1', name: 'demo', repoPath: cwd, allow: ['codex'], worker: 'codex', concurrency: null }
    const projects = {
      db,
      entries: new Map([[project.id, project]]),
      crews: () => [],
      publish() {},
      get(id) {
        if (id !== project.id) throw new Error('Unknown project')
        return project
      }
    }
    db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,repoPath TEXT,created INTEGER,allow TEXT,worker TEXT,concurrency INTEGER)')
    db.prepare('INSERT INTO projects VALUES (?,?,?,?,?,?,?)').run(project.id, project.name, project.repoPath, Date.now(), JSON.stringify(project.allow), project.worker, null)

    const roster = new Roster(projects)
    roster.setDefaults(project.id, 'codex', { model: 'mystery-legacy-v0' })

    const listed = await roster.list(project.id, false, { refresh: true })
    assert.equal(existsSync(join(canaryDir, 'claude')), false)
    assert.equal(existsSync(join(canaryDir, 'agy')), false)
    assert.equal(existsSync(join(canaryDir, 'cursor-agent')), false)

    const compact = rosterOutput(listed)
    assert.deepEqual(compact.workers.find(w => w.id === 'claude'), { id: 'claude', allowed: false })
    assert.deepEqual(compact.workers.find(w => w.id === 'agy'), { id: 'agy', allowed: false })
    assert.deepEqual(compact.workers.find(w => w.id === 'cursor-agent'), { id: 'cursor-agent', allowed: false })
    const codex = compact.workers.find(w => w.id === 'codex')
    assert.ok(codex.warnings.some(w => w.includes('mystery-legacy-v0')))
    db.close()
  `
  execFileSync(process.execPath, ['--input-type=module', '-e', script, h.cwd, canaryDir], {
    cwd: repo,
    env: { ...h.env, PATH: fakeBin + ':' + h.env.PATH },
    timeout: 20000
  })
})

test('direct agent config mutations update state immediately, sync slots concurrency, record timestamped audit, and support targeted + sequential undo', t => {
  const h = harness(t)
  mkdirSync(h.data, { recursive: true })
  assert.match(formatDateTime(Date.UTC(2026, 10, 17, 17, 0, 0), 'Asia/Shanghai'), /^2026-11-18 01:00:00$/)
  assert.match(formatDateTime(Date.UTC(2026, 10, 17, 17, 0, 0), 'UTC'), /^2026-11-17 17:00:00$/)
  assert.equal(formatShortTime(Date.UTC(2026, 10, 17, 17, 5, 9), 'UTC'), '11-17 17:05')
  assert.equal(resolvedTimeZone('Europe/London'), 'Europe/London')
  assert.ok(legacyCcBroHome({ CC_BRO_HOME: h.data }).endsWith('data'))
  assert.ok(legacyCcBroHome({}).endsWith('.cc-bro'))
  const script = `
    import assert from 'node:assert/strict'
    import { DatabaseSync } from 'node:sqlite'
    import { Roster } from './lib/roster.mjs'

    const db = new DatabaseSync(':memory:')
    const limitCalls = []
    const events = []
    const project = { id: 'proj-1', name: 'alpha', repoPath: '/tmp/alpha', allow: ['codex'], worker: 'codex', concurrency: null, created: Date.now() }
    db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,repoPath TEXT,created INTEGER,allow TEXT,worker TEXT,concurrency INTEGER)')
    db.prepare('INSERT INTO projects VALUES (?,?,?,?,?,?,?)').run(project.id, project.name, project.repoPath, project.created, JSON.stringify(project.allow), project.worker, null)

    let roster
    const projects = {
      db,
      slots: { setLimit: (scope, n) => limitCalls.push([scope, n]) },
      entries: new Map([[project.id, project]]),
      crews: () => [],
      publish: ev => events.push(ev),
      summary: id => ({ id, allow: project.allow, worker: project.worker, concurrency: roster.effective(project).concurrency }),
      get(id) {
        if (id !== project.id) throw new Error('Unknown project')
        return project
      }
    }
    roster = new Roster(projects)

    assert.equal(roster.effective(project).concurrency, 3)

    const gConc = roster.setConcurrency('global', 5, 'agent')
    assert.equal(gConc.concurrency, 5)
    assert.equal(roster.effective(project).concurrency, 5)
    assert.deepEqual(limitCalls.at(-1), [project.id, 5])

    const pConc = roster.setConcurrency(project.id, 8, 'agent')
    assert.equal(pConc.concurrency, 8)
    assert.equal(project.concurrency, 8)
    assert.deepEqual(limitCalls.at(-1), [project.id, 8])

    assert.throws(() => roster.setConcurrency(project.id, 0), /between 1 and 64/)
    assert.throws(() => roster.setConcurrency(project.id, 99), /between 1 and 64/)

    const def = roster.setDefaults(project.id, 'codex', { model: 'gpt-6-astra', effort: 'high' }, 'agent')
    assert.deepEqual(def.defaults, { model: 'gpt-6-astra', effort: 'high' })

    const note = roster.setNote(project.id, 'codex', 'Prefer isolated worktrees', 'agent')
    assert.equal(note.note, 'Prefer isolated worktrees')

    const rules = roster.setRules(project.id, { add: ['Run tests first', 'No code comments'] }, 'agent')
    assert.deepEqual(rules.rules, ['Run tests first', 'No code comments'])

    const workerRules = roster.setRules(project.id, { worker: 'codex', add: ['Keep diffs minimal'] }, 'agent')
    assert.deepEqual(workerRules.workerRules, ['Keep diffs minimal'])

    const hidden = roster.setHiddenModels(project.id, 'codex', { hide: ['gpt-5.6-sol-high'] }, 'agent')
    assert.deepEqual(hidden.hiddenModels, ['gpt-5.6-sol'])

    assert.throws(() => roster.setAllow(project.id, { add: ['custom:untested'] }), /tested template/)
    const allowRes = roster.setAllow(project.id, { add: ['agy'], defaultWorker: 'agy' }, 'agent')
    assert.deepEqual(allowRes.allow, ['codex', 'agy'])
    assert.equal(allowRes.defaultWorker, 'agy')

    const undoneNote = roster.undoAudit(note.auditId, { scope: project.id, actor: 'user' })
    assert.equal(undoneNote.undoneId, note.auditId)
    assert.equal(roster.effective(project).entries.codex?.note, undefined)
    assert.equal(roster.effective(project).entries.codex?.model, 'gpt-6-astra')
    assert.deepEqual(roster.effective(project).allow, ['codex', 'agy'])
    assert.equal(roster.effective(project).concurrency, 8)
    assert.throws(() => roster.undoAudit(note.auditId, { scope: project.id }), /already reverted/)

    const seq1 = roster.undoAudit(null, { scope: project.id, actor: 'agent' })
    assert.equal(seq1.undoneId, allowRes.auditId)
    assert.deepEqual(roster.effective(project).allow, ['codex'])
    assert.equal(roster.effective(project).worker, 'codex')

    const seq2 = roster.undoAudit({ scope: project.id, actor: 'agent' })
    assert.equal(seq2.undoneId, hidden.auditId)
    assert.deepEqual(roster.effective(project).entries.codex?.hiddenModels ?? [], [])

    roster.undoAudit(pConc.auditId, { scope: project.id, actor: 'user' })
    assert.equal(roster.effective(project).concurrency, 5)
    assert.deepEqual(limitCalls.at(-1), [project.id, 5])

    const log = roster.auditList(project.id, 20)
    assert.ok(log.length >= 9)
    assert.ok(log.every(entry => /^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$/.test(entry.atLocal)))
    assert.ok(events.some(e => e.type === 'settings' && e.scope === project.id))
    db.close()
  `
  execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repo,
    env: { ...h.env, BROCO_CONCURRENCY: '3', BROCO_TZ: 'UTC' },
    timeout: 15000
  })
})

test('Web audit and settings endpoints expose audit history and one-click undo, and Projects.uninit cleans markers', async t => {
  const h = harness(t)
  writeFileSync(join(h.cwd, 'CLAUDE.md'), '# Existing Doc\n')
  const p = await h.json('init', '--allow', 'codex')
  assert.equal(p.claudeMd.action, 'appended')
  assert.match(readFileSync(join(h.cwd, 'CLAUDE.md'), 'utf8'), /^# Existing Doc\n\n<!-- broco:start -->/)

  const moved = join(h.base, 'moved-without-claude-md')
  await h.cli('shutdown')
  rmSync(join(h.cwd, 'CLAUDE.md'))
  renameSync(h.cwd, moved)
  assert.deepEqual(JSON.parse(await h.at(moved, 'ls', '--json')), [])
  assert.equal(existsSync(join(moved, 'CLAUDE.md')), false)
  renameSync(moved, h.cwd)
  assert.deepEqual(await h.json('ls'), [])

  const url = await h.cli('ui', '--no-open')
  const callWeb = async (method, path, payload) => {
    const res = await fetch(url + path, {
      method,
      headers: payload ? { Origin: url, 'Content-Type': 'application/json' } : undefined,
      body: payload ? JSON.stringify(payload) : undefined
    })
    const body = await res.json()
    assert.ok(res.ok, JSON.stringify(body))
    return body
  }

  const initial = await callWeb('GET', '/api/settings/' + p.id)
  assert.ok(Array.isArray(initial.audit))
  assert.equal(initial.effectiveConcurrency, 3)

  initial.concurrency = 6
  initial.rules = ['Delegate reviews across vendors']
  const saved = await callWeb('POST', '/api/settings/' + p.id, initial)
  assert.equal(saved.effectiveConcurrency, 6)
  assert.equal(saved.audit.length, 1)

  const auditRows = await callWeb('GET', '/api/audit/' + p.id)
  assert.equal(auditRows.length, 1)
  assert.equal(auditRows[0].action, 'save')

  const reverted = await callWeb('POST', '/api/audit/' + p.id + '/undo', { id: auditRows[0].id })
  assert.equal(reverted.undoneId, auditRows[0].id)
  assert.equal(reverted.config.effectiveConcurrency, 3)
  assert.deepEqual(reverted.config.rules, [])

  await h.cli('shutdown')
  writeFileSync(join(h.cwd, 'CLAUDE.md'), '# Keep Header\n\n' + claudeMdBlock() + '\n')
  const uninitScript = `
    import assert from 'node:assert/strict'
    import { existsSync, readFileSync } from 'node:fs'
    import { join } from 'node:path'
    import { Projects } from './lib/projects.mjs'
    import { Slots } from './lib/slots.mjs'

    const cwd = process.argv[1]
    const mgr = new Projects(new Slots(3), () => {})
    await mgr.recover()
    const uninitRes = mgr.uninit(cwd)
    assert.equal(uninitRes.unregistered, true)
    assert.equal(uninitRes.markerRemoved, true)
    assert.equal(uninitRes.claudeMd.action, 'stripped')
    assert.equal(existsSync(join(cwd, '.broco')), false)
    assert.equal(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8'), '# Keep Header\\n')
    assert.throws(() => mgr.context(cwd), /not registered/)
    for (const c of mgr.crews()) c.store.db.close()
    mgr.db.close()
  `
  execFileSync(process.execPath, ['--input-type=module', '-e', uninitScript, h.cwd], {
    cwd: repo,
    env: h.env,
    timeout: 15000
  })
})
