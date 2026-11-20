import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { call } from '../lib/client.mjs'
import { repo, socketFor } from '../lib/paths.mjs'

const exec = promisify(execFile)

export function prependPath(env, ...dirs) {
  const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH'
  const current = env[pathKey] ?? ''
  for (const k of Object.keys(env)) {
    if (k !== 'PATH' && k.toLowerCase() === 'path') delete env[k]
  }
  env.PATH = [...dirs, ...(current ? [current] : [])].join(delimiter)
  return env
}

export function writeFakeCli(dir, name, jsSource) {
  const body = Array.isArray(jsSource) ? jsSource.join('\n') : jsSource
  const stripped = body.replace(/^#!\/usr\/bin\/env node\r?\n/, '')
  if (process.platform === 'win32') {
    const scriptPath = join(dir, name + '.mjs')
    const cmdPath = join(dir, name + '.cmd')
    writeFileSync(scriptPath, stripped)
    writeFileSync(cmdPath, '@echo off\r\n"' + process.execPath + '" "%~dp0' + name + '.mjs" %*\r\n')
    return cmdPath
  }
  const binPath = join(dir, name)
  writeFileSync(binPath, '#!/usr/bin/env node\n' + stripped, { mode: 0o755 })
  chmodSync(binPath, 0o755)
  return binPath
}

export async function until(check, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = await check()
    if (value) return value
    await sleep(80)
  }
  assert.fail('Timed out waiting for ' + check.toString().slice(0, 140))
}

export function alive(pid) {
  try { process.kill(pid, 0); return true }
  catch (err) { if (err.code !== 'ESRCH') throw err; return false }
}

export function harness(t, live = false, overrides = {}) {
  const sandbox = join(repo, '.sandbox')
  mkdirSync(sandbox, { recursive: true })
  const base = realpathSync(mkdtempSync(join(tmpdir(), live ? 'broco-live-' : 'broco-offline-')))
  const profile = realpathSync(mkdtempSync(join(sandbox, 'profile-')))
  const data = join(profile, 'data')
  const socket = socketFor(data)
  const cwd = join(base, 'work')
  mkdirSync(cwd)
  const env = { ...process.env, BROCO_HOME: data, BROCO_HOST_HOME: join(base, 'host-home'), CLAUDE_CONFIG_DIR: join(base, 'config'), BROCO_PORT: '0', ...overrides }
  if (!Object.prototype.hasOwnProperty.call(overrides, 'CC_BRO_HOME')) delete env.CC_BRO_HOME
  if (!live) prependPath(env, join(repo, 'test', 'fixtures'))
  const bin = join(repo, 'bin/broco')
  const cli = async (...args) => (await exec(process.execPath, [bin, ...args], { env, cwd, timeout: 100000 })).stdout.trim()
  const at = async (dir, ...args) => (await exec(process.execPath, [bin, ...args], { env, cwd: dir, timeout: 100000 })).stdout.trim()
  const json = async (...args) => JSON.parse(await cli(...args, '--json'))
  const children = new Set()
  function follow(...args) {
    const child = spawn(process.execPath, [bin, ...args], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const log = { child, stdout: '', stderr: '' }
    children.add(child)
    child.stdout.setEncoding('utf8').on('data', p => { log.stdout += p })
    child.stderr.setEncoding('utf8').on('data', p => { log.stderr += p })
    child.once('exit', () => children.delete(child))
    return log
  }
  let db
  function query(sql, ...params) {
    db ??= new DatabaseSync(join(data, 'projects', readFileSync(join(cwd, '.broco', 'project-id'), 'utf8').trim(), 'tickets.sqlite'), { readOnly: true })
    return db.prepare(sql).all(...params)
  }
  async function runnerPid() { return (await call('/ready', undefined, socket)).pid }
  t.after(async () => {
    for (const child of children) child.kill()
    db?.close()
    const activePid = await runnerPid().catch(() => null)
    const pidFile = join(data, 'runner.pid')
    const savedPid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8').trim()) : null
    if (activePid || savedPid || existsSync(join(data, 'runner.plist'))) {
      await cli('shutdown').catch(() => {})
    }
    for (const pid of [activePid, savedPid]) {
      if (Number.isSafeInteger(pid) && pid > 1) {
        try { process.kill(pid, 'SIGKILL') } catch {}
      }
    }
    if (process.platform === 'darwin') {
      const label = 'me.yanauto.broco.' + socket.split('-').at(-1).replace('.sock', '')
      await exec('/bin/launchctl', ['bootout', 'gui/' + process.getuid() + '/' + label], { timeout: 5000 }).catch(() => {})
    }
    if (process.platform !== 'win32') rmSync(socket, { force: true })
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })
  return { base, data, cwd, env, cli, at, json, follow, query, runnerPid }
}
