import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { home, isolated, toolsPath } from '../paths.mjs'

const exec = promisify(execFile)
const runnerPath = fileURLToPath(new URL('../runner.mjs', import.meta.url))

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

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false
  try { process.kill(pid, 0); return true }
  catch (err) { return err.code === 'EPERM' }
}

function parseProcStat(pidName) {
  try {
    const raw = readFileSync('/proc/' + pidName + '/stat', 'utf8')
    const close = raw.lastIndexOf(')')
    if (close < 0) return null
    const pid = Number(raw.slice(0, raw.indexOf(' ')))
    const rest = raw.slice(close + 2).trim().split(/\s+/)
    const state = rest[0]
    if (!Number.isSafeInteger(pid) || pid <= 1 || state === 'Z') return null
    const parent = Number(rest[1])
    const birth = rest[19] ?? ''
    return { pid, parent, birth }
  } catch {
    return null
  }
}

function processTable() {
  if (!existsSync('/proc')) return []
  const rows = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    const parsed = parseProcStat(entry)
    if (parsed) rows.push(parsed)
  }
  return rows
}

function holders(marker) {
  const st = statSync(marker, { throwIfNoEntry: false })
  if (!st || !existsSync('/proc')) return []
  const pids = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    if (pid <= 1 || pid === process.pid) continue
    let fds
    try { fds = readdirSync('/proc/' + entry + '/fd') } catch { continue }
    for (const fd of fds) {
      try {
        const fdStat = statSync('/proc/' + entry + '/fd/' + fd)
        if (fdStat.dev === st.dev && fdStat.ino === st.ino) {
          pids.push(pid)
          break
        }
      } catch {}
    }
  }
  return pids
}

export function owned(marker, known = [], childPid) {
  const marked = new Set(holders(marker))
  const table = processTable()
  const old = new Map(known.map(p => [p.pid, p.birth]))
  const roots = table.filter(p => marked.has(p.pid) || old.get(p.pid) === p.birth || (p.pid === childPid && p.parent === process.pid))
  const ids = new Set(roots.map(p => p.pid))
  let size
  do {
    size = ids.size
    for (const p of table) if (ids.has(p.parent)) ids.add(p.pid)
  } while (ids.size > size)
  return table.filter(p => ids.has(p.pid))
}

export async function reap(marker, known = []) {
  for (let i = 0; i < 24; i++) {
    known = owned(marker, known)
    if (!known.length) {
      rmSync(marker, { force: true })
      return
    }
    for (const p of known) {
      try { process.kill(p.pid, i < 5 ? 'SIGTERM' : 'SIGKILL') }
      catch (err) { if (err.code !== 'ESRCH') throw err }
    }
    await sleep(70)
  }
  throw new Error('Could not confirm that all owned processes exited')
}

export async function startService() {
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
  await stopPidFile(home)
}

export async function removeLegacyService(legacyDir) {
  if (!legacyDir) return
  await stopPidFile(legacyDir)
}

export function piCommand(args) {
  return ['pi', ...args]
}

export async function openBrowser(url) {
  await exec('xdg-open', [url])
}

export async function openTerminal(command, cwd) {
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error('No graphical display available on Linux; run directly: ' + command)
  }
  const quote = s => "'" + s.replaceAll("'", "'\\''") + "'"
  const shellCmd = 'cd -- ' + quote(cwd) + ' && PATH=' + quote(toolsPath) + ' ' + command + '; exec "${SHELL:-/bin/sh}"'
  await exec('x-terminal-emulator', ['-e', '/bin/sh', '-c', shellCmd])
  return { status: 'opened', command, cwd }
}
