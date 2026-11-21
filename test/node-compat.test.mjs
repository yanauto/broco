import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  MIN_NODE_VERSION,
  isSqliteExperimentalWarning,
  isSupportedNodeVersion,
  parseNodeVersion,
  silenceSqliteExperimentalWarning,
  unsupportedNodeMessage
} from '../lib/node-runtime.mjs'
import { Store } from '../lib/store.mjs'

const exec = promisify(execFile)
const repo = fileURLToPath(new URL('../', import.meta.url))
const bin = join(repo, 'bin', 'broco')

test('parseNodeVersion and isSupportedNodeVersion enforce Node 22.13.0+', () => {
  assert.equal(MIN_NODE_VERSION, '22.13.0')
  assert.deepEqual(parseNodeVersion('v22.13.0'), { major: 22, minor: 13, patch: 0 })
  assert.deepEqual(parseNodeVersion('24.21.0'), { major: 24, minor: 21, patch: 0 })
  assert.equal(parseNodeVersion('not-a-version'), null)

  assert.equal(isSupportedNodeVersion('18.20.4'), false)
  assert.equal(isSupportedNodeVersion('20.18.1'), false)
  assert.equal(isSupportedNodeVersion('22.0.0'), false)
  assert.equal(isSupportedNodeVersion('22.12.9'), false)
  assert.equal(isSupportedNodeVersion('22.13.0'), true)
  assert.equal(isSupportedNodeVersion('22.23.5'), true)
  assert.equal(isSupportedNodeVersion('24.0.0'), true)
  assert.equal(isSupportedNodeVersion('26.11.1'), true)
})

test('unsupportedNodeMessage includes version and both one-line installer URLs', () => {
  const msg = unsupportedNodeMessage('20.18.0')
  assert.match(msg, /Node\.js 22\.13\.0\+/)
  assert.match(msg, /v20\.18\.0/)
  assert.match(msg, /https:\/\/broco\.yanauto\.me\/install\.sh/)
  assert.match(msg, /https:\/\/broco\.yanauto\.me\/install\.ps1/)
})

test('broco exits cleanly with actionable installer error on unsupported Node versions', async () => {
  const preload = "data:text/javascript,Object.defineProperty(process.versions,'node',{value:'22.12.0'});"
  await assert.rejects(
    exec(process.execPath, ['--import', preload, bin, '--version'], { timeout: 10000 }),
    err => {
      assert.equal(err.code, 1)
      assert.equal(err.stdout, '')
      assert.match(err.stderr, /broco requires Node\.js 22\.13\.0\+ \(found v22\.12\.0\)/)
      assert.match(err.stderr, /https:\/\/broco\.yanauto\.me\/install\.sh/)
      assert.match(err.stderr, /https:\/\/broco\.yanauto\.me\/install\.ps1/)
      assert.doesNotMatch(err.stderr, /\bat\s+/)
      return true
    }
  )

  await assert.rejects(
    exec(process.execPath, ['--import', preload, bin, 'version', '--json'], { timeout: 10000 }),
    err => {
      assert.equal(err.code, 1)
      const parsed = JSON.parse(err.stdout.trim())
      assert.match(parsed.error, /Node\.js 22\.13\.0\+/)
      assert.match(parsed.error, /https:\/\/broco\.yanauto\.me\/install\.sh/)
      assert.match(parsed.error, /https:\/\/broco\.yanauto\.me\/install\.ps1/)
      assert.doesNotMatch(err.stderr, /\bat\s+/)
      return true
    }
  )
})

test('silenceSqliteExperimentalWarning filters only SQLite ExperimentalWarning', () => {
  assert.equal(isSqliteExperimentalWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning'), true)
  assert.equal(isSqliteExperimentalWarning('SQLite is an experimental feature', { type: 'ExperimentalWarning' }), true)
  assert.equal(isSqliteExperimentalWarning(Object.assign(new Error('SQLite is an experimental feature'), { name: 'ExperimentalWarning' })), true)
  assert.equal(isSqliteExperimentalWarning('Other feature is experimental', 'ExperimentalWarning'), false)
  assert.equal(isSqliteExperimentalWarning('SQLite deprecation', 'DeprecationWarning'), false)

  const seen = []
  const fakeProcess = {
    emitWarning(warning, type) {
      seen.push([warning, type])
    }
  }
  silenceSqliteExperimentalWarning(fakeProcess)
  fakeProcess.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning')
  fakeProcess.emitWarning('Other experimental feature', 'ExperimentalWarning')
  fakeProcess.emitWarning('Deprecated API', 'DeprecationWarning')

  assert.deepEqual(seen, [
    ['Other experimental feature', 'ExperimentalWarning'],
    ['Deprecated API', 'DeprecationWarning']
  ])
})

test('broco CLI emits clean JSON and zero SQLite ExperimentalWarning on stderr', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broco-node-compat-'))
  try {
    const env = { ...process.env, BROCO_HOME: join(dir, 'home') }
    const ver = await exec(process.execPath, [bin, 'version', '--json'], { cwd: dir, env, timeout: 10000 })
    assert.equal(ver.stderr, '')
    assert.equal(typeof JSON.parse(ver.stdout.trim()).version, 'string')

    const status = await exec(process.execPath, [bin, 'status', '--json'], { cwd: dir, env, timeout: 10000 })
    assert.equal(status.stderr, '')
    assert.equal(JSON.parse(status.stdout.trim()).runner.online, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Store.transaction supports nested transactions without DatabaseSync.isTransaction', () => {
  const dir = mkdtempSync(join(tmpdir(), 'broco-store-tx-'))
  const store = new Store(false, join(dir, 'tickets.sqlite'))
  try {
    const out = store.transaction(() => store.transaction(() => 42))
    assert.equal(out, 42)
    assert.equal(store.inTransaction, false)

    assert.throws(() => {
      store.transaction(() => {
        store.transaction(() => {
          throw new Error('inner boom')
        })
      })
    }, /inner boom/)
    assert.equal(store.inTransaction, false)

    const after = store.transaction(() => 'ok')
    assert.equal(after, 'ok')
  } finally {
    store.db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('detached runner emits zero SQLite ExperimentalWarning on stderr', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broco-runner-warn-'))
  const env = { ...process.env, BROCO_HOME: join(dir, 'home') }
  const runnerPath = join(repo, 'lib', 'runner.mjs')
  const child = spawn(process.execPath, [runnerPath], { cwd: tmpdir(), env, stdio: ['ignore', 'pipe', 'pipe'] })
  let runnerStderr = ''
  child.stderr.on('data', chunk => { runnerStderr += chunk.toString('utf8') })
  const waitClose = ms => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    const timer = setTimeout(resolve, ms)
    child.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  try {
    let online = false
    for (let i = 0; i < 80; i++) {
      const res = await exec(process.execPath, [bin, 'status', '--json'], { cwd: tmpdir(), env, timeout: 10000 })
      assert.equal(res.stderr, '')
      if (JSON.parse(res.stdout.trim()).runner.online) {
        online = true
        break
      }
      await sleep(75)
    }
    assert.equal(online, true)

    const down = await exec(process.execPath, [bin, 'shutdown', '--json'], { cwd: tmpdir(), env, timeout: 10000 })
    assert.equal(down.stderr, '')
    assert.equal(JSON.parse(down.stdout.trim()).status, 'offline')

    await waitClose(5000)
    assert.doesNotMatch(runnerStderr, /ExperimentalWarning/)
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL') } catch {}
      await waitClose(3000)
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

