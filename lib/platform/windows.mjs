import { execFile, execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { home, isolated, toolsPath } from '../paths.mjs'
import { getEnvVar, normalizeEnv, resolveCli } from '../spawn-cli.mjs'

const exec = promisify(execFile)
const runnerPath = fileURLToPath(new URL('../runner.mjs', import.meta.url))
const PRESERVED_WIN_VARS = [
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
  'TEMP',
  'TMP',
  'PATH',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'SystemDrive',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramData',
  'OS',
  'USERNAME',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE'
]
const PS_PROCESS_TABLE = 'Get-CimInstance Win32_Process | ForEach-Object { $ms = if ($_.CreationDate) { [long](($_.CreationDate.ToUniversalTime() - [datetime]\'1970-01-01\').TotalMilliseconds) } else { 0 }; "$($_.ProcessId)$([char]9)$($_.ParentProcessId)$([char]9)$ms" }'

function serviceEnv() {
  const env = {}
  for (const name of PRESERVED_WIN_VARS) {
    const val = getEnvVar(process.env, name)
    if (val !== undefined) env[name] = val
  }
  env.BROCO_HOME = home
  if (process.env.BROCO_PORT) env.BROCO_PORT = process.env.BROCO_PORT
  if (process.env.BROCO_CONCURRENCY) env.BROCO_CONCURRENCY = process.env.BROCO_CONCURRENCY
  if (process.env.BROCO_TZ) env.BROCO_TZ = process.env.BROCO_TZ
  if (process.env.TZ) env.TZ = process.env.TZ
  if (isolated) env.PI_CODING_AGENT_DIR = join(home, 'login')
  else if (process.env.PI_CODING_AGENT_DIR) env.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR
  env.PI_CODING_AGENT_SESSION_DIR = join(home, 'sessions')
  return env
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false
  try { process.kill(pid, 0); return true }
  catch (err) { return err.code === 'EPERM' }
}

function readMarkerRecords(marker) {
  if (!marker || !existsSync(marker)) return []
  let raw = ''
  try { raw = readFileSync(marker, 'utf8') } catch { return [] }
  const out = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (/^\d+$/.test(trimmed)) {
      const pid = Number(trimmed)
      if (Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid) out.push({ pid, created: null })
      continue
    }
    try {
      const parsed = JSON.parse(trimmed)
      const pid = Number(parsed?.pid)
      if (Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid) {
        const created = Number.isFinite(parsed?.created) ? parsed.created : null
        out.push({ pid, created })
      }
    } catch {}
  }
  return out
}

function parseProcessTable(output) {
  const rows = []
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split('\t')
    if (parts.length < 3) continue
    const pid = Number(parts[0])
    const parent = Number(parts[1])
    const birth = parts[2]
    if (!Number.isSafeInteger(pid) || pid <= 1 || !Number.isSafeInteger(parent) || parent < 0) continue
    rows.push({ pid, parent, birth })
  }
  return rows
}

function processTableSync() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_PROCESS_TABLE], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 8 * 1024 * 1024
    })
    return parseProcessTable(out)
  } catch {
    return null
  }
}

async function processTableAsync() {
  try {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_PROCESS_TABLE], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 8 * 1024 * 1024
    })
    return parseProcessTable(stdout)
  } catch {
    return null
  }
}

function birthMatchesMarker(birth, created) {
  if (!Number.isFinite(created)) return true
  const birthMs = Number(birth)
  if (!Number.isFinite(birthMs) || birthMs <= 0) return true
  return birthMs <= created + 15000 && birthMs >= created - 60000
}

function fallbackOwned(records, known, childPid) {
  const seen = new Map()
  for (const p of known) {
    if (alive(p.pid) && p.pid !== process.pid) seen.set(p.pid, p)
  }
  for (const r of records) {
    if (alive(r.pid) && r.pid !== process.pid && !seen.has(r.pid)) {
      seen.set(r.pid, { pid: r.pid, parent: 0, birth: String(r.created ?? 0) })
    }
  }
  if (Number.isSafeInteger(childPid) && childPid > 1 && childPid !== process.pid && alive(childPid) && !seen.has(childPid)) {
    seen.set(childPid, { pid: childPid, parent: process.pid, birth: '0' })
  }
  return [...seen.values()]
}

function computeOwned(table, records, known = [], childPid) {
  if (!table) return fallbackOwned(records, known, childPid)
  const old = new Map(known.map(p => [p.pid, p.birth]))
  const markedMap = new Map()
  for (const r of records) markedMap.set(r.pid, r.created)
  const livePids = new Set(table.map(p => p.pid))
  const deadMarked = new Map()
  for (const [pid, created] of markedMap) {
    if (!livePids.has(pid)) deadMarked.set(pid, created)
  }
  const roots = table.filter(p => {
    if (p.pid === process.pid) return false
    if (markedMap.has(p.pid) && birthMatchesMarker(p.birth, markedMap.get(p.pid))) return true
    if (old.has(p.pid) && old.get(p.pid) === p.birth) return true
    if (p.pid === childPid && p.parent === process.pid) return true
    if (deadMarked.has(p.parent)) {
      const created = deadMarked.get(p.parent)
      const birthMs = Number(p.birth)
      if (!Number.isFinite(created) || !Number.isFinite(birthMs) || birthMs <= 0 || birthMs >= created - 5000) return true
    }
    return false
  })
  const ids = new Set(roots.map(p => p.pid))
  let size
  do {
    size = ids.size
    for (const p of table) {
      if (p.pid !== process.pid && ids.has(p.parent)) ids.add(p.pid)
    }
  } while (ids.size > size)
  return table.filter(p => ids.has(p.pid))
}

export function owned(marker, known = [], childPid) {
  const records = readMarkerRecords(marker)
  const hasChild = Number.isSafeInteger(childPid) && childPid > 1 && childPid !== process.pid
  if (!records.length && !known.length && !hasChild) return []
  return computeOwned(processTableSync(), records, known, childPid)
}

async function ownedAsync(marker, known = [], childPid) {
  const records = readMarkerRecords(marker)
  const hasChild = Number.isSafeInteger(childPid) && childPid > 1 && childPid !== process.pid
  if (!records.length && !known.length && !hasChild) return []
  return computeOwned(await processTableAsync(), records, known, childPid)
}

async function unlinkRetry(target) {
  if (!target || !existsSync(target)) return
  for (let i = 0; i < 6; i++) {
    try {
      rmSync(target, { force: true })
      return
    } catch (err) {
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(err.code) || i === 5) throw err
      await sleep(50)
    }
  }
}

async function killPidTree(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return
  try {
    await exec('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000 })
    return
  } catch {}
  if (alive(pid)) {
    try { process.kill(pid) }
    catch (err) { if (err.code !== 'ESRCH' && err.code !== 'EPERM') throw err }
  }
}

export async function reap(marker, known = []) {
  for (let i = 0; i < 24; i++) {
    known = await ownedAsync(marker, known)
    if (!known.length) {
      await unlinkRetry(marker)
      return
    }
    const idSet = new Set(known.map(p => p.pid))
    const roots = known.filter(p => !idSet.has(p.parent))
    const targets = roots.length ? roots : known
    for (const p of targets) {
      await killPidTree(p.pid)
    }
    await sleep(70)
  }
  throw new Error('Could not confirm that all owned processes exited')
}

export async function startService() {
  mkdirSync(home, { recursive: true })
  const pidFile = join(home, 'runner.pid')
  if (existsSync(pidFile)) {
    const existing = Number(readFileSync(pidFile, 'utf8').trim())
    if (alive(existing)) return
  }
  const child = spawn(process.execPath, [runnerPath], {
    cwd: home,
    env: normalizeEnv({ ...process.env, ...serviceEnv() }),
    detached: true,
    windowsHide: true,
    stdio: 'ignore'
  })
  writeFileSync(pidFile, String(child.pid) + '\n')
  child.unref()
}

async function stopPidFile(dir) {
  const pidFile = join(dir, 'runner.pid')
  if (!existsSync(pidFile)) return
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  await unlinkRetry(pidFile)
  if (!alive(pid)) return
  const gracefulDeadline = Date.now() + 500
  while (Date.now() < gracefulDeadline && alive(pid)) await sleep(50)
  if (alive(pid)) {
    await killPidTree(pid)
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
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Refusing to open non-HTTP URL: ' + url)
  }
  await exec('rundll32.exe', ['url.dll,FileProtocolHandler', parsed.href], { windowsHide: true })
}

export async function openTerminal(command, cwd) {
  const psQuote = s => "'" + String(s).replaceAll("'", "''") + "'"
  const psCommand = (isolated ? '$env:PATH = ' + psQuote(toolsPath) + '; ' : '') + command
  const wt = resolveCli('wt.exe')
  if (wt) {
    await exec(wt, ['-d', cwd, 'powershell.exe', '-NoExit', '-Command', psCommand], { windowsHide: false })
    return { status: 'opened', command, cwd }
  }
  const ps = resolveCli('powershell.exe')
  if (ps) {
    const comspec = getEnvVar(process.env, 'ComSpec') || 'cmd.exe'
    await exec(comspec, ['/d', '/c', 'start', '""', '/D', cwd, ps, '-NoExit', '-Command', psCommand], { windowsHide: true })
    return { status: 'opened', command, cwd }
  }
  const comspec = getEnvVar(process.env, 'ComSpec') || 'cmd.exe'
  await exec(comspec, ['/d', '/c', 'start', '""', '/D', cwd, comspec, '/k', command], { windowsHide: true })
  return { status: 'opened', command, cwd }
}

export async function hasDesktop() {
  return true
}

export async function reveal(targetPath) {
  await exec('explorer.exe', ['/select,' + targetPath]).catch(() => {})
}
