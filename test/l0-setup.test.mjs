import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { promisify } from 'node:util'
import { SUPPORTED_HOSTS } from '../lib/claude-md.mjs'
import { commandHelp, parseCommand } from '../lib/cli-args.mjs'
import { legacySocketsFor } from '../lib/client.mjs'
import { repo, socketFor } from '../lib/paths.mjs'
import { FIRST_RUN_PROMPT, formatQuotaBar, readGlobalPolicy, setupInfo } from '../lib/setup.mjs'
import { HOST_SESSION_VARS } from '../lib/templates.mjs'
import { harness, prependPath, writeFakeCli } from './harness.mjs'

const exec = promisify(execFile)
const bin = join(repo, 'bin', 'broco')

function initGitRepo(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'init'], { cwd: dir })
}

test('L0 zero-init runs across commands without creating dotfiles, normalizes to git root, and inherits global policy', async t => {
  const h = harness(t)
  const repoDir = join(h.base, 'zero-init-repo')
  const subA = join(repoDir, 'packages', 'api')
  const subB = join(repoDir, 'docs')
  mkdirSync(subA, { recursive: true })
  mkdirSync(subB, { recursive: true })
  initGitRepo(repoDir)

  await assert.rejects(h.at(subA, 'roster'), /broco setup.*broco allow .*--global/i)
  await assert.rejects(h.at(subA, 'ls'), /broco setup.*broco allow .*--global/i)
  assert.equal(existsSync(join(repoDir, '.broco')), false)
  assert.equal(existsSync(join(repoDir, 'AGENTS.md')), false)
  assert.equal(existsSync(join(repoDir, 'CLAUDE.md')), false)

  await h.cli('allow', 'codex,agy', '--default-worker', 'codex', '--global')
  await h.cli('set', 'concurrency', '2', '--global')

  const rosterA = JSON.parse(await h.at(subA, 'roster', '--json'))
  assert.equal(rosterA.defaultWorker, 'codex')
  assert.equal(rosterA.concurrency, 2)
  assert.equal(rosterA.workers.find(w => w.id === 'codex')?.allowed, true)
  assert.equal(rosterA.workers.find(w => w.id === 'agy')?.allowed, true)

  const statusBefore = JSON.parse(await h.at(subA, 'status', '--json'))
  assert.equal(statusBefore.project, null)
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repoDir, encoding: 'utf8' }), '')

  const said = JSON.parse(await h.at(subA, 'say', 'l0-task', 'hello from l0', '--json'))
  assert.equal(said.reply, 'hello from l0')

  const statusA = JSON.parse(await h.at(subA, 'status', '--json'))
  assert.equal(statusA.project.implicit, true)
  assert.equal(statusA.project.repoPath, realpathSync.native(repoDir))
  assert.equal(statusA.project.concurrency, 2)
  assert.equal(existsSync(join(repoDir, '.broco')), false)
  assert.equal(existsSync(join(repoDir, 'AGENTS.md')), false)
  assert.equal(existsSync(join(repoDir, 'CLAUDE.md')), false)

  const listFromB = JSON.parse(await h.at(subB, 'ls', '--json'))
  assert.equal(listFromB.length, 1)
  assert.equal(listFromB[0].id, 'l0-task')

  const shown = JSON.parse(await h.at(subB, 'show', 'l0-task', '--compact', '--json'))
  assert.equal(shown.reply, 'hello from l0')

  const diffRes = JSON.parse(await h.at(subB, 'diff', 'l0-task', '--json'))
  assert.equal(diffRes.name, 'l0-task')

  const waited = JSON.parse(await h.at(subB, 'wait', 'l0-task', '--json'))
  assert.equal(waited.reply, 'hello from l0')

  const doneRes = JSON.parse(await h.at(subB, 'done', 'l0-task', '--result', 'pass', '--why', 'verified in l0', '--json'))
  assert.equal(doneRes.outcome, 'pass')

  const mapRes = JSON.parse(await h.at(subA, 'map', 'l0-batch', '--brief', '{input}', '--inputs', 'alpha,beta', '--bg', '--json'))
  assert.equal(mapRes.count, 2)
  const mapWait = JSON.parse(await h.at(subB, 'wait', 'l0-batch', '--json'))
  assert.equal(mapWait.counts.review, 2)
  await h.at(subB, 'done', 'l0-batch', '--result', 'pass', '--why', 'l0 batch ok')

  await h.at(subA, 'say', 'l0-stop', 'hold', '--bg')
  const stoppedRes = JSON.parse(await h.at(subB, 'stop', 'l0-stop', '--json'))
  assert.equal(stoppedRes.status, 'stopped')
  const retriedRes = JSON.parse(await h.at(subA, 'retry', 'l0-stop', '--bg', '--json'))
  assert.equal(retriedRes.retriedTurn, 1)
  await h.at(subB, 'stop', 'l0-stop')

  const statsRes = JSON.parse(await h.at(subB, 'stats', '--project', repoDir, '--json'))
  assert.equal(statsRes.length, 1)
  assert.equal(statsRes[0].pass, 3)

  const cleanRes = JSON.parse(await h.at(subB, 'clean', '--dry-run', '--json'))
  assert.deepEqual(cleanRes.cleaned, [])

  await h.cli('set', 'concurrency', '5', '--global')
  assert.equal(JSON.parse(await h.at(subA, 'roster', '--json')).concurrency, 5)

  assert.equal(existsSync(join(repoDir, '.broco')), false)
  assert.equal(existsSync(join(repoDir, '.cc-bro')), false)
  assert.equal(existsSync(join(repoDir, 'AGENTS.md')), false)
  assert.equal(existsSync(join(repoDir, 'CLAUDE.md')), false)
  assert.equal(existsSync(join(subA, '.broco')), false)
  const porcelain = execFileSync('git', ['status', '--porcelain'], { cwd: repoDir, encoding: 'utf8' })
  assert.doesNotMatch(porcelain, /\.broco|\.cc-bro|AGENTS\.md|CLAUDE\.md/)

  const plainDir = join(h.base, 'plain-dir')
  const plainSub = join(plainDir, 'nested')
  mkdirSync(plainSub, { recursive: true })
  assert.equal(JSON.parse(await h.at(plainDir, 'say', 'plain-job', 'plain ok', '--json')).reply, 'plain ok')
  assert.equal(JSON.parse(await h.at(plainSub, 'ls', '--json'))[0].id, 'plain-job')
  assert.equal(existsSync(join(plainDir, '.broco')), false)
})

test('L1 explicit init strictly overrides global policy for directory and nested subrepos, and upgrades L0 cleanly', async t => {
  const h = harness(t)
  await h.cli('allow', 'codex,agy,pi:deepseek', '--default-worker', 'codex', '--global')
  await h.cli('set', 'concurrency', '6', '--global')
  await h.cli('rules', '--add', 'Global default rule', '--global')

  const privateDir = join(h.base, 'private-vault')
  const nestedSubRepo = join(privateDir, 'nested-subrepo')
  mkdirSync(nestedSubRepo, { recursive: true })
  initGitRepo(nestedSubRepo)

  const initRes = JSON.parse(await h.at(privateDir, 'init', '--allow', 'agy', '--concurrency', '1', '--json'))
  assert.equal(initRes.implicit, false)
  assert.deepEqual(initRes.allow, ['agy'])
  assert.equal(initRes.worker, 'agy')
  assert.equal(initRes.concurrency, 1)
  assert.equal(initRes.agentsMd.file, 'AGENTS.md')
  assert.equal(initRes.agentsMd.mode, 'on-demand')
  assert.equal(existsSync(join(privateDir, 'AGENTS.md')), true)
  assert.equal(existsSync(join(privateDir, 'CLAUDE.md')), false)
  assert.match(readFileSync(join(privateDir, 'AGENTS.md'), 'utf8'), /broco On-Demand Crew/)

  await h.at(privateDir, 'rules', '--override', '--add', 'Private repo only')

  const subRoster = JSON.parse(await h.at(nestedSubRepo, 'roster', '--json'))
  assert.equal(subRoster.projectId, initRes.id)
  assert.equal(subRoster.defaultWorker, 'agy')
  assert.equal(subRoster.concurrency, 1)
  assert.equal(subRoster.workers.find(w => w.id === 'codex')?.allowed, false)
  assert.deepEqual(subRoster.rules, ['Private repo only'])

  await assert.rejects(h.at(nestedSubRepo, 'say', 'leak', 'secret', '--worker', 'codex'), /not allowed/)
  assert.equal(JSON.parse(await h.at(nestedSubRepo, 'say', 'ok-priv', 'allowed agy', '--json')).reply, 'allowed agy')

  const upgradeDir = join(h.base, 'upgrade-from-l0')
  mkdirSync(upgradeDir, { recursive: true })
  assert.equal(JSON.parse(await h.at(upgradeDir, 'say', 'before', 'hello l0', '--json')).reply, 'hello l0')
  assert.equal(existsSync(join(upgradeDir, '.broco')), false)

  const upgraded = JSON.parse(await h.at(upgradeDir, 'init', '--allow', 'agy', '--concurrency', '2', '--json'))
  assert.equal(upgraded.implicit, false)
  assert.equal(existsSync(join(upgradeDir, '.broco', 'project-id')), true)
  assert.equal(JSON.parse(await h.at(upgradeDir, 'ls', '--json'))[0].id, 'before')
  await assert.rejects(h.at(upgradeDir, 'say', 'blocked-after-l1', 'nope', '--worker', 'codex'), /not allowed/)
})

test('init AGENTS.md vs CLAUDE.md resolution, --host, --manager-mode, --no-agents-md, and uninit cleanup', async t => {
  const h = harness(t)

  const dirAgents = join(h.base, 'doc-agents')
  mkdirSync(dirAgents)
  const r1 = JSON.parse(await h.at(dirAgents, 'init', '--allow', 'codex', '--json'))
  assert.equal(r1.agentsMd.file, 'AGENTS.md')
  assert.equal(r1.agentsMd.mode, 'on-demand')
  assert.match(readFileSync(join(dirAgents, 'AGENTS.md'), 'utf8'), /broco On-Demand Crew/)
  assert.doesNotMatch(readFileSync(join(dirAgents, 'AGENTS.md'), 'utf8'), /broco Manager Mode/)

  const r1Mgr = JSON.parse(await h.at(dirAgents, 'init', '--manager-mode', '--json'))
  assert.equal(r1Mgr.agentsMd.action, 'updated')
  assert.equal(r1Mgr.agentsMd.mode, 'manager')
  assert.match(readFileSync(join(dirAgents, 'AGENTS.md'), 'utf8'), /broco Manager Mode/)

  const dirClaudeExisting = join(h.base, 'doc-claude-existing')
  mkdirSync(dirClaudeExisting)
  writeFileSync(join(dirClaudeExisting, 'CLAUDE.md'), '# Existing Claude Rules\n')
  const r2 = JSON.parse(await h.at(dirClaudeExisting, 'init', '--allow', 'codex', '--json'))
  assert.equal(r2.agentsMd.file, 'CLAUDE.md')
  assert.equal(r2.agentsMd.action, 'appended')
  assert.equal(existsSync(join(dirClaudeExisting, 'AGENTS.md')), false)
  assert.match(readFileSync(join(dirClaudeExisting, 'CLAUDE.md'), 'utf8'), /# Existing Claude Rules\n\n<!-- broco:start -->/)

  const dirBoth = join(h.base, 'doc-both')
  mkdirSync(dirBoth)
  writeFileSync(join(dirBoth, 'AGENTS.md'), '# Existing Agents\n')
  writeFileSync(join(dirBoth, 'CLAUDE.md'), '# Existing Claude\n')
  const r3 = JSON.parse(await h.at(dirBoth, 'init', '--allow', 'codex', '--json'))
  assert.equal(r3.agentsMd.file, 'AGENTS.md')
  assert.equal(readFileSync(join(dirBoth, 'CLAUDE.md'), 'utf8'), '# Existing Claude\n')

  const dirHostClaude = join(h.base, 'doc-host-claude')
  mkdirSync(dirHostClaude)
  const r4 = JSON.parse(await h.at(dirHostClaude, 'init', '--allow', 'codex', '--host', 'claude', '--json'))
  assert.equal(r4.agentsMd.file, 'CLAUDE.md')
  assert.equal(existsSync(join(dirHostClaude, 'CLAUDE.md')), true)
  assert.equal(existsSync(join(dirHostClaude, 'AGENTS.md')), false)

  const dirSkip = join(h.base, 'doc-skip')
  mkdirSync(dirSkip)
  const r5 = JSON.parse(await h.at(dirSkip, 'init', '--allow', 'codex', '--no-agents-md', '--json'))
  assert.equal(r5.agentsMd, undefined)
  assert.equal(existsSync(join(dirSkip, 'AGENTS.md')), false)
  assert.equal(existsSync(join(dirSkip, 'CLAUDE.md')), false)

  const uninitRes = JSON.parse(await h.at(dirClaudeExisting, 'uninit', '--json'))
  assert.equal(uninitRes.agentsMd.file, 'CLAUDE.md')
  assert.equal(uninitRes.agentsMd.action, 'stripped')
  assert.equal(readFileSync(join(dirClaudeExisting, 'CLAUDE.md'), 'utf8'), '# Existing Claude Rules\n')
})

test('BROCO_IN_WORKER=1 blocks nested say, review, map, and retry unless --allow-nested is passed', async t => {
  const h = harness(t)
  await h.json('init', '--allow', 'codex,agy', '--default-worker', 'codex')
  const nestedEnv = { ...h.env, BROCO_IN_WORKER: '1' }

  for (const args of [
    ['say', 'nested-a', 'hello'],
    ['review', 'nested-a'],
    ['map', 'nested-m', '--brief', '{input}', '--inputs', 'x'],
    ['retry', 'nested-a']
  ]) {
    await assert.rejects(
      exec(process.execPath, [bin, ...args], { env: nestedEnv, cwd: h.cwd }),
      err => {
        assert.match(err.stderr, /BROCO_IN_WORKER=1/)
        assert.match(err.stderr, /--allow-nested/)
        return true
      }
    )
  }

  assert.equal(parseCommand(['retry', 'nested-a', '--allow-nested']).opt['allow-nested'], true)

  const listOk = await exec(process.execPath, [bin, 'ls', '--json'], { env: nestedEnv, cwd: h.cwd })
  assert.deepEqual(JSON.parse(listOk.stdout.trim()), [])

  const allowedSay = await exec(process.execPath, [bin, 'say', 'nested-ok', 'permitted', '--allow-nested', '--json'], { env: nestedEnv, cwd: h.cwd })
  assert.equal(JSON.parse(allowedSay.stdout.trim()).reply, 'permitted')

  const allowedMap = await exec(process.execPath, [bin, 'map', 'nested-map', '--brief', '{input}', '--inputs', 'item1', '--allow-nested', '--bg', '--json'], { env: nestedEnv, cwd: h.cwd })
  assert.equal(JSON.parse(allowedMap.stdout.trim()).count, 1)
})

test('review allows omitting --by and passes by: null to /review RPC', async t => {
  const parsedOmitted = parseCommand(['review', 'feature-x'])
  assert.equal(parsedOmitted.cmd, 'review')
  assert.deepEqual(parsedOmitted.positionals, ['feature-x'])
  assert.equal(parsedOmitted.opt.by, undefined)

  const tempRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'broco-review-rpc-')))
  const dataDir = join(tempRoot, 'data')
  const workDir = join(tempRoot, 'work')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(workDir, { recursive: true })
  const sock = socketFor(dataDir)
  rmSync(sock, { force: true })

  const reviewBodies = []
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/ready' && req.method === 'GET') {
      res.end(JSON.stringify({ pid: process.pid, protocol: 15, credentialProxy: true }))
      return
    }
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    if (req.url === '/context') {
      res.end(JSON.stringify({ projectId: 'p-mock', database: join(dataDir, 'mock.sqlite'), defaultCwd: workDir }))
      return
    }
    if (req.url === '/review') {
      reviewBodies.push(body)
      res.end(JSON.stringify({
        name: body.name + '-review-1',
        task: 1,
        number: 1,
        turn: 1,
        worker: body.by ?? 'agy',
        model: 'auto-model',
        outcome: 'accepted'
      }))
      return
    }
    res.statusCode = 404
    res.end(JSON.stringify({ error: 'unexpected route ' + req.url }))
  })
  server.listen(sock)
  await once(server, 'listening')
  t.after(() => {
    server.close()
    rmSync(sock, { force: true })
    rmSync(tempRoot, { recursive: true, force: true })
  })

  const env = { ...process.env, BROCO_HOME: dataDir }
  const outOmitted = await exec(process.execPath, [bin, 'review', 'feature-x', '--bg', '--json'], { env, cwd: workDir })
  assert.equal(JSON.parse(outOmitted.stdout.trim()).name, 'feature-x-review-1')
  assert.equal(reviewBodies[0].name, 'feature-x')
  assert.equal(reviewBodies[0].by, null)

  const outExplicit = await exec(process.execPath, [bin, 'review', 'feature-x', '--by', 'agy', '--bg', '--json'], { env, cwd: workDir })
  assert.equal(JSON.parse(outExplicit.stdout.trim()).worker, 'agy')
  assert.equal(reviewBodies[1].by, 'agy')
})

test('setup syncs skills only to existing host dirs, renders quota bars, never silently allows CLIs, and supports --allow / --yes', async t => {
  const h = harness(t)
  const fakeHome = join(h.base, 'user-home')
  mkdirSync(join(fakeHome, '.claude'), { recursive: true })
  mkdirSync(join(fakeHome, '.codex'), { recursive: true })
  mkdirSync(join(fakeHome, '.gemini', 'config'), { recursive: true })

  const setupEnv = { ...h.env, BROCO_HOST_HOME: fakeHome }
  delete setupEnv.CLAUDE_CONFIG_DIR
  delete setupEnv.CODEX_HOME
  delete setupEnv.PI_CODING_AGENT_DIR

  const nonInteractive = JSON.parse((await exec(process.execPath, [bin, 'setup', '--json'], { env: setupEnv, cwd: h.cwd })).stdout.trim())
  assert.equal(existsSync(join(fakeHome, '.agents', 'skills', 'broco', 'SKILL.md')), true)
  assert.equal(existsSync(join(fakeHome, '.agents', 'skills', 'broco', process.platform === 'win32' ? 'broco.cmd' : 'broco')), true)
  assert.equal(existsSync(join(fakeHome, '.claude', 'skills', 'broco', 'SKILL.md')), true)
  assert.equal(existsSync(join(fakeHome, '.codex', 'skills', 'broco', 'SKILL.md')), true)
  assert.equal(existsSync(join(fakeHome, '.gemini', 'config', 'skills', 'broco', 'SKILL.md')), true)
  assert.equal(existsSync(join(fakeHome, '.cursor')), false)
  assert.equal(existsSync(join(fakeHome, '.config', 'opencode')), false)
  assert.equal(existsSync(join(fakeHome, '.pi', 'agent')), false)
  assert.deepEqual(nonInteractive.skippedHosts.sort(), ['cursor', 'opencode', 'pi'])

  assert.equal(nonInteractive.allowlist.configured, false)
  assert.deepEqual(nonInteractive.allowlist.allow, [])
  assert.match(nonInteractive.allowlist.hint, /broco allow .*--global/)
  assert.equal(readGlobalPolicy(h.data).configured, false)
  assert.equal(nonInteractive.firstRunPrompt, FIRST_RUN_PROMPT)
  assert.ok(nonInteractive.detected.some(w => w.id === 'codex' && w.loggedIn))
  assert.match(formatQuotaBar({ source: 'native', windows: [{ minutes: 300, usedPercent: 20 }] }), /5h \[████████░░\] 80% left/)

  const textOut = (await exec(process.execPath, [bin, 'setup'], { env: setupEnv, cwd: h.cwd })).stdout
  assert.match(textOut, /Skills installed:/)
  assert.match(textOut, /Detected CLIs & live quota:/)
  assert.match(textOut, /broco allow .*--global/)
  assert.ok(textOut.includes(FIRST_RUN_PROMPT))

  const withAllow = JSON.parse((await exec(process.execPath, [bin, 'setup', '--allow', 'codex,agy', '--default-worker', 'agy', '--json'], { env: setupEnv, cwd: h.cwd })).stdout.trim())
  assert.equal(withAllow.allowlist.configured, true)
  assert.equal(withAllow.allowlist.changed, true)
  assert.deepEqual(withAllow.allowlist.allow, ['codex', 'agy'])
  assert.equal(withAllow.allowlist.defaultWorker, 'agy')

  const freshDir = join(h.base, 'after-setup-l0')
  mkdirSync(freshDir)
  assert.equal(JSON.parse(await h.at(freshDir, 'roster', '--json')).defaultWorker, 'agy')

  const h2 = harness(t)
  const customSkillsHome = join(h2.base, 'custom-skills')
  const envYes = { ...h2.env, BROCO_HOST_HOME: join(h2.base, 'home-yes'), BROCO_SKILLS_HOME: customSkillsHome }
  const withYes = JSON.parse((await exec(process.execPath, [bin, 'setup', '--yes', '--json'], { env: envYes, cwd: h2.cwd })).stdout.trim())
  assert.equal(withYes.allowlist.configured, true)
  assert.equal(withYes.allowlist.confirmedBy, 'yes')
  assert.ok(withYes.allowlist.allow.includes('codex'))
  assert.equal(existsSync(join(customSkillsHome, 'broco', 'SKILL.md')), true)
  assert.equal(existsSync(join(customSkillsHome, 'broco', process.platform === 'win32' ? 'broco.cmd' : 'broco')), true)
  assert.match(readFileSync(join(customSkillsHome, 'broco', 'SKILL.md'), 'utf8'), /On-Demand Crew/)
  assert.match(readFileSync(join(customSkillsHome, 'broco', 'SKILL.md'), 'utf8'), /BROCO_IN_WORKER=1/)
})

test('setup detects legacy ~/.cc-bro, guards active legacy runner, and --migrate-cc-bro copies safely without deleting source', async t => {
  const h = harness(t)
  const legacyDir = join(h.base, 'legacy-cc-bro')
  mkdirSync(join(legacyDir, 'projects', 'proj-legacy'), { recursive: true })

  const regDb = new DatabaseSync(join(legacyDir, 'registry-v2.sqlite'))
  regDb.exec(
    'CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,repoPath TEXT NOT NULL UNIQUE,created INTEGER NOT NULL,allow TEXT NOT NULL,worker TEXT NOT NULL,concurrency INTEGER);' +
    'CREATE TABLE roster_settings(scope TEXT PRIMARY KEY,revision INTEGER NOT NULL,data TEXT NOT NULL);'
  )
  regDb.prepare('INSERT INTO roster_settings VALUES (?,?,?)').run(
    'global',
    1,
    JSON.stringify({ allow: ['agy', 'codex'], worker: 'agy', entries: {}, rules: ['Migrated rule'] })
  )
  regDb.close()
  writeFileSync(join(legacyDir, 'projects', 'proj-legacy', 'marker.txt'), 'kept-data')
  writeFileSync(join(legacyDir, 'runner.lock'), 'transient-lock')

  const migEnv = { ...h.env, CC_BRO_HOME: legacyDir }

  const preview = JSON.parse((await exec(process.execPath, [bin, 'setup', '--json'], { env: migEnv, cwd: h.cwd })).stdout.trim())
  assert.equal(preview.migration.available, true)
  assert.equal(preview.migration.command, 'broco setup --migrate-cc-bro')
  assert.equal(existsSync(join(h.data, 'registry-v2.sqlite')), false)

  const previewText = (await exec(process.execPath, [bin, 'setup'], { env: migEnv, cwd: h.cwd })).stdout
  assert.match(previewText, /broco setup --migrate-cc-bro/)

  const legacySock = socketFor(legacyDir)
  if (process.platform !== 'win32') rmSync(legacySock, { force: true })
  const fakeLegacyRunner = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ pid: process.pid, protocol: 15 }))
  })
  fakeLegacyRunner.listen(legacySock)
  await once(fakeLegacyRunner, 'listening')
  t.after(() => {
    fakeLegacyRunner.close()
    if (process.platform !== 'win32') rmSync(legacySock, { force: true })
  })

  await assert.rejects(
    exec(process.execPath, [bin, 'setup', '--migrate-cc-bro'], { env: migEnv, cwd: h.cwd }),
    err => {
      assert.match(err.stderr, /broco shutdown/i)
      return true
    }
  )
  assert.equal(existsSync(join(h.data, 'registry-v2.sqlite')), false)

  await new Promise(ok => fakeLegacyRunner.close(ok))
  if (process.platform !== 'win32') rmSync(legacySock, { force: true })

  const migrated = JSON.parse((await exec(process.execPath, [bin, 'setup', '--migrate-cc-bro', '--json'], { env: migEnv, cwd: h.cwd })).stdout.trim())
  assert.equal(migrated.migration.migrated, true)
  assert.equal(migrated.migration.preservedLegacy, true)
  assert.equal(existsSync(join(legacyDir, 'registry-v2.sqlite')), true)
  assert.equal(existsSync(join(legacyDir, 'projects', 'proj-legacy', 'marker.txt')), true)
  assert.equal(existsSync(join(h.data, 'registry-v2.sqlite')), true)
  assert.equal(existsSync(join(h.data, 'projects', 'proj-legacy', 'marker.txt')), true)
  assert.equal(existsSync(join(h.data, 'runner.lock')), false)
  assert.deepEqual(migrated.allowlist.allow, ['agy', 'codex'])
  assert.equal(migrated.allowlist.defaultWorker, 'agy')

  await assert.rejects(
    exec(process.execPath, [bin, 'setup', '--migrate-cc-bro'], { env: migEnv, cwd: h.cwd }),
    /refusing to overwrite/i
  )
})

test('broco shutdown stops legacy ~/.cc-bro hash socket and unblocks --migrate-cc-bro', { skip: process.platform === 'win32' }, async t => {
  if (process.platform === 'win32') return
  const h = harness(t)
  const legacyDir = join(h.base, 'legacy-shutdown-src')
  mkdirSync(legacyDir, { recursive: true })
  const regDb = new DatabaseSync(join(legacyDir, 'registry-v2.sqlite'))
  regDb.exec(
    'CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,repoPath TEXT NOT NULL UNIQUE,created INTEGER NOT NULL,allow TEXT NOT NULL,worker TEXT NOT NULL,concurrency INTEGER);' +
    'CREATE TABLE roster_settings(scope TEXT PRIMARY KEY,revision INTEGER NOT NULL,data TEXT NOT NULL);'
  )
  regDb.prepare('INSERT INTO roster_settings VALUES (?,?,?)').run(
    'global',
    1,
    JSON.stringify({ allow: ['codex'], worker: 'codex', entries: {}, rules: [] })
  )
  regDb.close()

  const legacySock = legacySocketsFor(socketFor(legacyDir))[0]
  mkdirSync(dirname(legacySock), { recursive: true, mode: 0o700 })
  rmSync(legacySock, { force: true })
  let shutdownCalled = false
  const legacyServer = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/shutdown') {
      shutdownCalled = true
      res.end(JSON.stringify({ status: 'offline' }))
      setImmediate(() => {
        legacyServer.close()
        rmSync(legacySock, { force: true })
      })
      return
    }
    res.end(JSON.stringify({ pid: process.pid, protocol: 14 }))
  })
  legacyServer.listen(legacySock)
  await once(legacyServer, 'listening')
  t.after(() => {
    try { legacyServer.close() } catch {}
    rmSync(legacySock, { force: true })
  })

  const migEnv = { ...h.env, CC_BRO_HOME: legacyDir }
  await assert.rejects(
    exec(process.execPath, [bin, 'setup', '--migrate-cc-bro'], { env: migEnv, cwd: h.cwd }),
    /broco shutdown/i
  )

  const stopped = JSON.parse((await exec(process.execPath, [bin, 'shutdown', '--json'], { env: migEnv, cwd: h.cwd })).stdout.trim())
  assert.equal(stopped.status, 'offline')
  assert.equal(shutdownCalled, true)

  const migrated = JSON.parse((await exec(process.execPath, [bin, 'setup', '--migrate-cc-bro', '--json'], { env: migEnv, cwd: h.cwd })).stdout.trim())
  assert.equal(migrated.migration.migrated, true)
  assert.deepEqual(migrated.allowlist.allow, ['codex'])
})

test('claude signed-out or unknown login is never silently allowed in setup --yes or roster --global', async t => {
  const h = harness(t)
  const fakeBin = join(h.base, 'claude-bin')
  mkdirSync(fakeBin, { recursive: true })
  writeFakeCli(fakeBin, 'claude', [
    'const args = process.argv.slice(2);',
    'if (args.includes("--version")) { console.log("2.1.325 (Claude Code)"); process.exit(0); }',
    'if (args[0] === "auth") {',
    '  if (process.env.FAKE_CLAUDE_MODE === "unknown") { console.error("unexpected error"); process.exit(1); }',
    '  console.log(JSON.stringify({ loggedIn: false })); process.exit(1);',
    '}',
    'process.exit(1);'
  ])

  for (const mode of ['signed-out', 'unknown']) {
    const hCase = harness(t)
    const caseEnv = prependPath({ ...hCase.env, FAKE_CLAUDE_MODE: mode }, fakeBin)
    const setupRes = JSON.parse((await exec(process.execPath, [bin, 'setup', '--yes', '--json'], { env: caseEnv, cwd: hCase.cwd })).stdout.trim())
    const claudeDetected = setupRes.detected.find(w => w.id === 'claude')
    assert.equal(claudeDetected.loggedIn, false)
    assert.equal(setupRes.allowlist.allow.includes('claude'), false)

    const hGlobal = harness(t)
    const globalEnv = prependPath({ ...hGlobal.env, FAKE_CLAUDE_MODE: mode }, fakeBin)
    const rosterRes = JSON.parse((await exec(process.execPath, [bin, 'roster', '--global', '--refresh', '--json'], { env: globalEnv, cwd: hGlobal.cwd })).stdout.trim())
    assert.equal(rosterRes.globalAllowConfigured, false)
    const claudeRow = rosterRes.workers.find(w => w.id === 'claude')
    assert.ok(claudeRow)
    assert.equal(claudeRow.allowed, false)
    assert.deepEqual(claudeRow.models, [])
  }
})

test('read-only commands in an unregistered directory do not create implicit L0 projects', async t => {
  const h = harness(t)
  await h.json('allow', 'codex', '--global', '--default-worker', 'codex')
  const strayDir = join(h.base, 'stray-readonly-dir')
  mkdirSync(strayDir, { recursive: true })

  const before = JSON.parse(await h.at(strayDir, 'status', '--all', '--json'))
  assert.equal(before.projects.some(p => p.repoPath.includes('stray-readonly-dir')), false)

  await h.at(strayDir, 'audit', '--json')
  await h.at(strayDir, 'rules', '--json')
  await h.at(strayDir, 'ls', '--json')
  await h.at(strayDir, 'roster', '--json')

  const after = JSON.parse(await h.at(strayDir, 'status', '--all', '--json'))
  assert.equal(after.projects.some(p => p.repoPath.includes('stray-readonly-dir')), false)
  assert.equal(existsSync(join(strayDir, '.broco')), false)
})

test('pi host setup uses deduplicated symlink, respects PI_CODING_AGENT_DIR, replaces legacy copy, and guards self-overlap', t => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'broco-pi-setup-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const homeDefault = join(root, 'home-default')
  mkdirSync(join(homeDefault, '.pi', 'agent'), { recursive: true })
  const envDefault = { PATH: process.env.PATH ?? '/usr/bin:/bin' }

  const first = setupInfo({ homeDir: homeDefault, env: envDefault })
  const universalDir = join(homeDefault, '.agents', 'skills', 'broco')
  const piSkillDir = join(homeDefault, '.pi', 'agent', 'skills', 'broco')
  assert.ok(first.hosts.some(host => host.id === 'pi'))
  assert.equal(first.skippedHosts.includes('pi'), false)
  assert.equal(lstatSync(piSkillDir).isSymbolicLink(), true)
  assert.equal(realpathSync.native(piSkillDir), realpathSync.native(universalDir))
  assert.equal(existsSync(join(piSkillDir, 'SKILL.md')), true)

  const second = setupInfo({ homeDir: homeDefault, env: envDefault })
  assert.deepEqual(second.hosts, first.hosts)
  assert.equal(lstatSync(piSkillDir).isSymbolicLink(), true)
  assert.equal(realpathSync.native(piSkillDir), realpathSync.native(universalDir))

  const homeCustom = join(root, 'home-custom')
  const customPiDir = join(root, 'custom-pi-agent')
  const customRes = setupInfo({ homeDir: homeCustom, env: { ...envDefault, PI_CODING_AGENT_DIR: customPiDir } })
  const customPiSkillDir = join(customPiDir, 'skills', 'broco')
  assert.ok(customRes.hosts.some(host => host.id === 'pi'))
  assert.equal(lstatSync(customPiSkillDir).isSymbolicLink(), true)
  assert.equal(realpathSync.native(customPiSkillDir), realpathSync.native(join(homeCustom, '.agents', 'skills', 'broco')))

  const homeLegacy = join(root, 'home-legacy')
  const legacyPiSkillDir = join(homeLegacy, '.pi', 'agent', 'skills', 'broco')
  mkdirSync(legacyPiSkillDir, { recursive: true })
  writeFileSync(join(legacyPiSkillDir, 'SKILL.md'), 'legacy physical copy')
  assert.equal(lstatSync(legacyPiSkillDir).isDirectory(), true)
  assert.equal(lstatSync(legacyPiSkillDir).isSymbolicLink(), false)

  const replaced = setupInfo({ homeDir: homeLegacy, env: envDefault })
  assert.ok(replaced.hosts.some(host => host.id === 'pi'))
  assert.equal(lstatSync(legacyPiSkillDir).isSymbolicLink(), true)
  assert.equal(realpathSync.native(legacyPiSkillDir), realpathSync.native(join(homeLegacy, '.agents', 'skills', 'broco')))
  assert.match(readFileSync(join(legacyPiSkillDir, 'SKILL.md'), 'utf8'), /On-Demand Crew/)

  const homeOverlap = join(root, 'home-overlap')
  const overlapSkills = join(homeOverlap, '.pi', 'agent', 'skills')
  mkdirSync(overlapSkills, { recursive: true })
  const overlapFirst = setupInfo({ homeDir: homeOverlap, skillsHome: overlapSkills, env: envDefault })
  const overlapDir = join(overlapSkills, 'broco')
  assert.ok(overlapFirst.hosts.some(host => host.id === 'pi'))
  assert.equal(lstatSync(overlapDir).isDirectory(), true)
  assert.equal(lstatSync(overlapDir).isSymbolicLink(), false)
  assert.equal(existsSync(join(overlapDir, 'SKILL.md')), true)
  assert.equal(existsSync(overlapFirst.launcher), true)

  const overlapSecond = setupInfo({ homeDir: homeOverlap, skillsHome: overlapSkills, env: envDefault })
  assert.deepEqual(overlapSecond.hosts, overlapFirst.hosts)
  assert.equal(lstatSync(overlapDir).isSymbolicLink(), false)
  assert.equal(existsSync(join(overlapDir, 'SKILL.md')), true)
})

test('pi --host writes AGENTS.md, CLI help lists pi, and HOST_SESSION_VARS strips pi parent session vars', async t => {
  assert.equal(SUPPORTED_HOSTS.includes('pi'), true)
  assert.match(commandHelp('init'), /opencode\|pi/)
  for (const name of ['AI_AGENT', 'PI_CODING_AGENT', 'PI_SESSION_ID', 'PI_SESSION_FILE', 'PI_PROVIDER', 'PI_MODEL', 'PI_REASONING_LEVEL']) {
    assert.equal(HOST_SESSION_VARS.includes(name), true, 'Missing HOST_SESSION_VARS entry: ' + name)
  }
  assert.equal(HOST_SESSION_VARS.includes('PI_CODING_AGENT_DIR'), false)
  assert.equal(HOST_SESSION_VARS.includes('PI_CODING_AGENT_SESSION_DIR'), false)

  const h = harness(t)
  const dirHostPi = join(h.base, 'doc-host-pi')
  mkdirSync(dirHostPi)
  writeFileSync(join(dirHostPi, 'CLAUDE.md'), '# Existing Claude Rules\n')

  const initRes = JSON.parse(await h.at(dirHostPi, 'init', '--allow', 'codex', '--host', 'pi', '--json'))
  assert.equal(initRes.agentsMd.file, 'AGENTS.md')
  assert.equal(initRes.agentsMd.action, 'created')
  assert.equal(existsSync(join(dirHostPi, 'AGENTS.md')), true)
  assert.match(readFileSync(join(dirHostPi, 'AGENTS.md'), 'utf8'), /<!-- broco:start -->/)
  assert.equal(readFileSync(join(dirHostPi, 'CLAUDE.md'), 'utf8'), '# Existing Claude Rules\n')

  const uninitRes = JSON.parse(await h.at(dirHostPi, 'uninit', '--host', 'pi', '--json'))
  assert.equal(uninitRes.agentsMd.file, 'AGENTS.md')
  assert.equal(uninitRes.agentsMd.action, 'deleted')
  assert.equal(existsSync(join(dirHostPi, 'AGENTS.md')), false)
  assert.equal(readFileSync(join(dirHostPi, 'CLAUDE.md'), 'utf8'), '# Existing Claude Rules\n')
})
