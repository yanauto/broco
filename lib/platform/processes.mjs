import { execFile, execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'

const exec = promisify(execFile)

function parseProcessTable(output) {
  const trimmed = output.trim()
  if (!trimmed) return []
  const rows = []
  for (const line of trimmed.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/)
    if (!match) continue
    const [, pid, parent, state, birth] = match
    if (state.startsWith('Z')) continue
    rows.push({ pid: Number(pid), parent: Number(parent), birth })
  }
  return rows
}

function processTable() {
  const output = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,state=,lstart='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
  return parseProcessTable(output)
}

async function processTableAsync() {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,state=,lstart='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 8 * 1024 * 1024 })
  return parseProcessTable(stdout)
}

function parseHolders(output) {
  const text = (output ?? '').trim()
  if (!text) return []
  const pids = text.split(/\s+/).map(Number)
  if (pids.some(pid => !Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid)) {
    throw new Error('Invalid process identity')
  }
  return pids
}

function holders(marker) {
  if (!existsSync(marker)) return []
  try {
    const output = execFileSync('/usr/sbin/lsof', ['-nP', '-t', '--', marker], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return parseHolders(output)
  } catch (err) {
    if (!existsSync(marker) || /No such file or directory/i.test(err.stderr ?? '')) return []
    if (err.status === 1 && !err.stdout?.trim() && !err.stderr?.trim()) return []
    throw new Error('Cannot verify pi process ownership with lsof')
  }
}

async function holdersAsync(marker) {
  if (!existsSync(marker)) return []
  try {
    const { stdout } = await exec('/usr/sbin/lsof', ['-nP', '-t', '--', marker], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
    return parseHolders(stdout)
  } catch (err) {
    if (!existsSync(marker) || /No such file or directory/i.test(err.stderr ?? '')) return []
    if (err.code === 1 && !err.stdout?.trim() && !err.stderr?.trim()) return []
    throw new Error('Cannot verify pi process ownership with lsof')
  }
}

function computeOwned(table, markedIds, known = [], childPid) {
  const marked = new Set(markedIds)
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

export function owned(marker, known = [], childPid) {
  return computeOwned(processTable(), holders(marker), known, childPid)
}

export async function ownedAsync(marker, known = [], childPid) {
  const [markedIds, table] = await Promise.all([holdersAsync(marker), processTableAsync()])
  return computeOwned(table, markedIds, known, childPid)
}

export async function reap(marker, known = []) {
  for (let i = 0; i < 24; i++) {
    known = await ownedAsync(marker, known)
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
