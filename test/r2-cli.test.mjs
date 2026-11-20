import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { repo } from '../lib/paths.mjs'
import { harness, until } from './harness.mjs'

function spawnWithStdin(bin, args, stdinText, { env, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.setEncoding('utf8').on('data', d => { stdout += d })
    child.stderr.setEncoding('utf8').on('data', d => { stderr += d })
    child.once('error', reject)
    child.once('close', code => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }))
    child.stdin.end(stdinText)
  })
}

test('say reads multi-line backtick/$VAR prompts from --file, stdin dash, and piped stdin without shell expansion', async t => {
  const h = harness(t)
  const bin = join(repo, 'bin/broco')
  await h.json('init', '--allow', 'codex')

  const trickyPrompt = [
    'Line 1 with `backticks` and $(not_a_subshell) and $UNEXPANDED_VAR',
    '```js',
    'const x = "double" + \'single\';',
    '```'
  ].join('\n')

  const promptFile = join(h.base, 'prompt.md')
  writeFileSync(promptFile, trickyPrompt)

  const fromFile = await h.json('say', 's-file', '--file', promptFile)
  assert.equal(fromFile.reply, trickyPrompt)

  const fromDash = await spawnWithStdin(bin, ['say', 's-dash', '-', '--json'], trickyPrompt, { env: h.env, cwd: h.cwd })
  assert.equal(fromDash.code, 0, fromDash.stderr)
  assert.equal(JSON.parse(fromDash.stdout).reply, trickyPrompt)

  const fromPipe = await spawnWithStdin(bin, ['say', 's-pipe', '--json'], trickyPrompt, { env: h.env, cwd: h.cwd })
  assert.equal(fromPipe.code, 0, fromPipe.stderr)
  assert.equal(JSON.parse(fromPipe.stdout).reply, trickyPrompt)

  const fromFileDash = await spawnWithStdin(bin, ['say', 's-file-dash', '--file', '-', '--json'], trickyPrompt, { env: h.env, cwd: h.cwd })
  assert.equal(fromFileDash.code, 0, fromFileDash.stderr)
  assert.equal(JSON.parse(fromFileDash.stdout).reply, trickyPrompt)

  await assert.rejects(h.cli('say', 'conflict', 'inline', '--file', promptFile), /Specify either <message> or --file/)
  await assert.rejects(h.cli('say', 'missing-f', '--file', join(h.base, 'nope.md')), /Prompt file not found/)
})

test('status works offline without starting runner, init/ui/setup/shutdown support --project and --json, and web_port auto-restores', async t => {
  const h = harness(t)
  const outside = join(h.base, 'outside')
  mkdirSync(outside)

  const offlineBefore = JSON.parse(await h.at(outside, 'status', '--json'))
  assert.equal(offlineBefore.runner.online, false)
  assert.equal(offlineBefore.runner.compatible, true)
  assert.equal(offlineBefore.totals.projects, 0)
  assert.equal(await h.runnerPid().catch(() => null), null)

  const setupOut = await h.json('setup')
  assert.ok(setupOut.launcher)
  assert.ok(setupOut.skillPath)
  assert.equal(await h.runnerPid().catch(() => null), null)

  const initOut = JSON.parse(await h.at(outside, 'init', '--project', h.cwd, '--allow', 'codex', '--concurrency', '4', '--json'))
  assert.equal(initOut.concurrency, 4)

  const uiOut = await h.json('ui', '--no-open')
  assert.match(uiOut.url, /^http:\/\/127\.0\.0\.1:\d+$/)

  const onlineStatus = JSON.parse(await h.at(outside, 'status', '--project', h.cwd, '--all', '--json'))
  assert.equal(onlineStatus.runner.online, true)
  assert.equal(onlineStatus.runner.protocol, 15)
  assert.equal(onlineStatus.runner.webUrl, uiOut.url)
  assert.equal(onlineStatus.project.concurrency, 4)
  assert.equal(onlineStatus.projects.length, 1)

  const firstPid = await h.runnerPid()
  process.kill(firstPid, 'SIGTERM')
  await until(async () => (await h.runnerPid().catch(() => null)) !== firstPid)

  await h.json('ls')
  const restoredStatus = await h.json('status')
  assert.equal(restoredStatus.runner.webUrl, uiOut.url)
  const res = await fetch(uiOut.url + '/api/projects')
  assert.equal(res.status, 200)

  const shutOut = await h.json('shutdown')
  assert.equal(shutOut.status, 'offline')

  const offlineAfter = await h.json('status')
  assert.equal(offlineAfter.runner.online, false)
  assert.match(offlineAfter.runner.lastStopReason ?? '', /shutdown-rpc/)
  assert.equal(await h.runnerPid().catch(() => null), null)
})

test('roster --global, stats outside registered cwd, concise unknown-command error, and structured --json errors work cleanly', async t => {
  const h = harness(t)
  const outside = join(h.base, 'unregistered')
  mkdirSync(outside)

  await assert.rejects(h.at(outside, 'nonexistent-cmd'), err => {
    assert.match(err.stderr, /Unknown command "nonexistent-cmd"; available:/)
    assert.ok(err.stderr.split('\n').length <= 3)
    return true
  })

  await assert.rejects(h.at(outside, 'roster', '--json'), err => {
    const parsed = JSON.parse(err.stdout.trim())
    assert.match(parsed.error, /--global/)
    return true
  })

  const globalRoster = JSON.parse(await h.at(outside, 'roster', '--global', '--json'))
  assert.equal(globalRoster.projectId, null)
  assert.ok(Array.isArray(globalRoster.workers))
  assert.ok(globalRoster.workers.length >= 1)

  const emptyStats = JSON.parse(await h.at(outside, 'stats', '--json'))
  assert.deepEqual(emptyStats, [])

  await h.json('init', '--allow', 'codex')
  await h.json('say', 's1', 'task one')
  await h.json('done', 's1', '--result', 'pass', '--why', 'ok')

  const crossStats = JSON.parse(await h.at(outside, 'stats', '--json'))
  assert.equal(crossStats.length, 1)
  assert.equal(crossStats[0].pass, 1)

  const projStats = JSON.parse(await h.at(outside, 'stats', '--project', h.cwd, '--json'))
  assert.equal(projStats.length, 1)
  assert.equal(projStats[0].pass, 1)
})

test('event-driven /wait returns enriched fields, diff shows tracked+untracked edits, and clean removes worktrees safely', async t => {
  const h = harness(t)
  execFileSync('git', ['init', '-q'], { cwd: h.cwd })
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'initial'], { cwd: h.cwd })
  await h.json('init', '--allow', 'agy,codex', '--default-worker', 'agy')

  await h.json('say', 'wt-job', 'write fixture', '--worktree', '--bg')
  const waited = await h.json('wait', 'wt-job')
  assert.equal(waited.status, 'done')
  assert.equal(waited.task, 1)
  assert.equal(waited.worker, 'agy')
  assert.ok(waited.worktree && existsSync(waited.worktree))
  assert.ok(waited.branch)
  assert.ok(waited.changedFiles.some(f => f.path === 'stream-proof.txt'))

  const diffStat = await h.cli('diff', 'wt-job', '--stat')
  assert.match(diffStat, /stream-proof\.txt/)
  const diffJson = await h.json('diff', 'wt-job')
  assert.ok(diffJson.baseHead)
  assert.match(diffJson.patch, /stream-proof\.txt/)

  await h.json('done', 'wt-job', '--result', 'pass', '--why', 'verified diff')

  const blockedClean = await h.json('clean', 'wt-job')
  assert.equal(blockedClean.cleaned.length, 0)
  assert.equal(blockedClean.skipped.length, 1)
  assert.match(blockedClean.skipped[0].reason, /uncommitted/)

  const dryClean = await h.json('clean', 'wt-job', '--force', '--dry-run')
  assert.equal(dryClean.cleaned.length, 1)
  assert.equal(dryClean.cleaned[0].dryRun, true)
  assert.equal(existsSync(waited.worktree), true)

  const realClean = await h.json('clean', 'wt-job', '--force', '--delete-branch')
  assert.equal(realClean.cleaned.length, 1)
  assert.equal(realClean.cleaned[0].branchDeleted, true)
  assert.equal(existsSync(waited.worktree), false)

  const afterShow = await h.json('show', 'wt-job', '--compact')
  assert.equal(afterShow.worktree, null)
  assert.equal(afterShow.cleanupHint, undefined)
  assert.equal(afterShow.lastReply, undefined)
  assert.equal(afterShow.timeline, undefined)
  assert.ok(Number.isInteger(afterShow.timelineCount))
})

test('ls filters, show --turn/batch --full/--status, map --inputs-file + missing-brief guard, and batch retry <prefix>', async t => {
  const h = harness(t)
  const bin = join(repo, 'bin/broco')
  await h.json('init', '--allow', 'codex', '--concurrency', '2')

  await assert.rejects(h.cli('map', 'bad-brief', '--brief', 'nonexistent-spec.md', '--input', 'a'), /Brief file not found/)

  const inputsFile = join(h.base, 'shards.txt')
  writeFileSync(inputsFile, 'alpha\nbeta\nhold\n')

  const briefStdin = await spawnWithStdin(
    bin,
    ['map', 'b1', '--brief-file', '-', '--inputs-file', inputsFile, '--bg', '--json'],
    '{input}',
    { env: h.env, cwd: h.cwd }
  )
  assert.equal(briefStdin.code, 0, briefStdin.stderr)
  const dispatched = JSON.parse(briefStdin.stdout)
  assert.equal(dispatched.count, 3)

  await until(async () => {
    const d = await h.json('show', 'b1')
    return d.counts.review === 2 && d.counts.working === 1
  })
  await h.json('stop', 'b1-3')

  const stoppedOnly = await h.json('show', 'b1', '--status', 'stopped')
  assert.equal(stoppedOnly.count, 3)
  assert.equal(stoppedOnly.shards.length, 1)
  assert.equal(stoppedOnly.shards[0].name, 'b1-3')

  const fullBatch = await h.json('show', 'b1', '--full')
  assert.equal(fullBatch.shards[0].reply, 'alpha')

  await h.json('done', 'b1-1', '--result', 'pass', '--why', 'ok')

  assert.equal((await h.json('ls', '--active')).length, 2)
  assert.deepEqual((await h.json('ls', '--status', 'done')).map(r => r.id), ['b1-1'])
  assert.deepEqual((await h.json('ls', '--flag', 'stopped')).map(r => r.id), ['b1-3'])
  assert.equal((await h.json('ls', '--batch', 'b1')).length, 3)
  assert.equal((await h.json('ls', '--limit', '2')).length, 2)

  await h.cli('say', 'b1-3', 'recovered shard 3')
  const turn1 = await h.json('show', 'b1-3', '--turn', '1', '--compact')
  assert.equal(turn1.turn, 1)
  assert.equal(turn1.status, 'stopped')
  const turn2 = await h.json('show', 'b1-3', '--turn', '2', '--compact')
  assert.equal(turn2.turn, 2)
  assert.equal(turn2.reply, 'recovered shard 3')

  await h.json('map', 'b2', '--brief', '{input}', '--inputs', 'ok-1,hold', '--bg')
  await until(async () => {
    const d = await h.json('show', 'b2')
    return d.counts.review === 1 && d.counts.working === 1
  })
  await h.json('stop', 'b2-2')
  const storePath = join(h.data, 'projects', readFileSync(join(h.cwd, '.broco', 'project-id'), 'utf8').trim(), 'tickets.sqlite')
  const { DatabaseSync } = await import('node:sqlite')
  const fixDb = new DatabaseSync(storePath)
  fixDb.prepare("UPDATE messages SET content='ok-2-retried' WHERE cid=(SELECT id FROM conversations WHERE name='b2-2') AND turn=1 AND kind='prompt'").run()
  fixDb.close()

  const retriedBg = await h.json('retry', 'b2', '--bg')
  assert.equal(retriedBg.isBatch, true)
  assert.equal(retriedBg.retried.length, 1)
  assert.equal(retriedBg.retried[0].name, 'b2-2')
  assert.equal(retriedBg.skipped.length, 1)

  const waitedB2 = await h.json('wait', 'b2')
  assert.equal(waitedB2.counts.review, 2)
  assert.equal(waitedB2.shards[1].replyPreview, 'ok-2-retried')
})
