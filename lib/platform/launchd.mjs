import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { home, isolated, socketFor, socketPath } from '../paths.mjs'

const exec = promisify(execFile)
const runnerPath = fileURLToPath(new URL('../runner.mjs', import.meta.url))

export function serviceLabelFor(socket = socketPath) {
  return 'me.yanauto.broco.' + socket.split('-').at(-1).replace('.sock', '')
}

export function legacyServiceLabelFor(socket = socketPath) {
  return 'me.yanauto.cc-bro.' + socket.split('-').at(-1).replace('.sock', '')
}

const label = serviceLabelFor(socketPath)
const domain = 'gui/' + process.getuid()
const target = domain + '/' + label

function ctl(...args) {
  return exec('/bin/launchctl', args, { timeout: 10000 })
}

function serviceEnv() {
  return {
    BROCO_HOME: home,
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...(process.env.BROCO_PORT ? { BROCO_PORT: process.env.BROCO_PORT } : {}),
    ...(process.env.BROCO_CONCURRENCY ? { BROCO_CONCURRENCY: process.env.BROCO_CONCURRENCY } : {}),
    ...(process.env.BROCO_TZ ? { BROCO_TZ: process.env.BROCO_TZ } : {}),
    ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
    ...(isolated ? { PI_CODING_AGENT_DIR: join(home, 'login') } :
      process.env.PI_CODING_AGENT_DIR ? { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR } : {}),
    PI_CODING_AGENT_SESSION_DIR: join(home, 'sessions')
  }
}

function useDetachedRunner() {
  return isolated && process.env.BROCO_FORCE_LAUNCHD !== '1'
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false
  try { process.kill(pid, 0); return true }
  catch (err) { return err.code === 'EPERM' }
}

export async function startService() {
  if (useDetachedRunner()) {
    mkdirSync(home, { recursive: true, mode: 0o700 })
    const pidFile = join(home, 'runner.pid')
    if (existsSync(pidFile)) {
      const existing = Number(readFileSync(pidFile, 'utf8').trim())
      if (alive(existing)) return
    }
    const child = spawn(process.execPath, [runnerPath], {
      cwd: home,
      env: { ...process.env, ...serviceEnv() },
      detached: true,
      stdio: 'ignore'
    })
    writeFileSync(pidFile, String(child.pid) + '\n', { mode: 0o600 })
    child.unref()
    return
  }

  mkdirSync(home, { recursive: true, mode: 0o700 })
  const path = join(home, 'runner.plist')
  const specPath = join(home, 'runner.spec.json')
  const values = {
    Label: label,
    ThrottleInterval: 1,
    ProgramArguments: [process.execPath, runnerPath],
    EnvironmentVariables: serviceEnv()
  }
  const specJson = JSON.stringify(values)
  const unchanged = existsSync(path) && existsSync(specPath) && readFileSync(specPath, 'utf8') === specJson
  if (unchanged) {
    try {
      await ctl('kickstart', target)
      return
    } catch (err) {
      if (err.code === 37) return
    }
  } else if (existsSync(path)) {
    try { await ctl('bootout', target) } catch {}
  }

  const tmp = path + '.' + randomUUID()
  writeFileSync(tmp, specJson, { mode: 0o600 })
  try {
    await exec('/usr/bin/plutil', ['-convert', 'xml1', tmp])
    renameSync(tmp, path)
    writeFileSync(specPath, specJson, { mode: 0o600 })
  } finally { rmSync(tmp, { force: true }) }
  try { await ctl('bootstrap', domain, path) } catch {}
  try { await ctl('kickstart', target) }
  catch (err) {
    if (err.code === 37) return
    throw new Error('Could not start the broco launchd service in ' + domain)
  }
}

async function stopPidFile(dir) {
  const pidFile = join(dir, 'runner.pid')
  if (!existsSync(pidFile)) return
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  rmSync(pidFile, { force: true })
  if (alive(pid)) {
    try { process.kill(pid, 'SIGTERM') } catch {}
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && alive(pid)) await sleep(50)
  }
}

export async function removeService() {
  if (useDetachedRunner()) {
    await stopPidFile(home)
    return
  }
  try { await ctl('bootout', target) }
  catch (err) { if (![3, 36, 113].includes(err.code)) throw err }
}

export async function removeLegacyService(legacyDir) {
  if (!legacyDir) return
  await stopPidFile(legacyDir)
  if (useDetachedRunner()) return
  const legacyTarget = domain + '/' + legacyServiceLabelFor(socketFor(legacyDir))
  try { await ctl('bootout', legacyTarget) }
  catch (err) { if (![3, 36, 113].includes(err.code)) throw err }
}
